import { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'

export default async function AuditLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'admin' && user.role !== 'audit')) {
    redirect('/')
  }
  return children
}
