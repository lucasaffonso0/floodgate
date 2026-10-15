#!/usr/bin/env node
// Prints Namespace + Service manifests for a synthetic large cluster, to
// exercise floodgate's graph, lists and K8s reads at scale. Services carry a
// selector (floodgate skips selectorless Services) but no pods are created:
// the graph only needs the Services to exist.
//
// Usage:
//   node scripts/perf/gen-scale-cluster.mjs --namespaces 1000 --services 5000 | kubectl apply -f -
// Cleanup:
//   kubectl delete ns -l floodgate-scale-test=true
//
// Naming is shared with fake-hubble-relay.mjs and seed-flows.mjs:
// namespace "scale-ns-<i>", service "svc-<j>" (services spread round-robin).

import { parseArgs } from './args.mjs'

const args = parseArgs({ namespaces: 1000, services: 5000 })
const nsCount = Number(args.namespaces)
const svcCount = Number(args.services)

const docs = []
for (let i = 0; i < nsCount; i++) {
  docs.push(`apiVersion: v1
kind: Namespace
metadata:
  name: scale-ns-${i}
  labels:
    floodgate-scale-test: "true"`)
}
for (let j = 0; j < svcCount; j++) {
  const ns = `scale-ns-${j % nsCount}`
  docs.push(`apiVersion: v1
kind: Service
metadata:
  name: svc-${j}
  namespace: ${ns}
  labels:
    floodgate-scale-test: "true"
spec:
  selector:
    app: svc-${j}
  ports:
    - name: http
      port: 80
      targetPort: 8080
      protocol: TCP`)
}
process.stdout.write(docs.join('\n---\n') + '\n')
