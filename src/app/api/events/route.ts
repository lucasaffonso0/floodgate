import { getCurrentUser } from '@/lib/auth'
import { addWriter, removeWriter, writerCount } from '@/lib/sse'
import { NextResponse } from 'next/server'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  if (writerCount() >= 200) return new NextResponse('Too Many Connections', { status: 429 })

  const encoder = new TextEncoder()
  let write: (chunk: string) => void

  const stream = new ReadableStream({
    start(controller) {
      write = (chunk: string) => {
        try { controller.enqueue(encoder.encode(chunk)) } catch { removeWriter(write) }
      }
      addWriter(write)
      // Initial ping to confirm connection
      controller.enqueue(encoder.encode(': connected\n\n'))
    },
    cancel() {
      removeWriter(write)
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable Nginx buffering
    },
  })
}
