# floodgate

Kubernetes NetworkPolicy manager with an interactive drag-and-drop graph UI. Visualize services, create and delete policies, manage access control — all from a single web app running inside your cluster.

---

## Features

- **Interactive graph** — services grouped by namespace, policies rendered as colored edges
- **Drag-and-drop** — draw connections between services to create allow rules
- **Role-based access** — admin, ns_admin, viewer, audit
- **Approval workflow** — require N approvals before a policy is applied
- **Autosync** — drift detection re-applies policies removed externally
- **Real-time updates** — Server-Sent Events push changes to all connected users in < 100 ms
- **Audit log** — every action recorded with user, timestamp, and details
- **Namespace isolation** — one-click default-deny (ingress, egress, or both)
- **Pause/Resume** — remove all policies from the cluster temporarily and restore them

---

## Deploy

### Production

**Prerequisites:** Kubernetes cluster, `kubectl`, `helm`, and a container registry.

**1. Build and push the image**

```bash
docker build -t your-registry/floodgate:1.0.0 .
docker push your-registry/floodgate:1.0.0
```

**2. Update `helm-app-template/helmvalues/values.yaml`**

```yaml
image:
  repository: your-registry/floodgate
  tag: "1.0.0"
```

**3. Create namespace and JWT secret (once)**

```bash
kubectl create namespace floodgate
kubectl create secret generic floodgate-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -base64 32)" \
  -n floodgate
```

**4. Install**

```bash
helm install floodgate ./helm-app-template \
  -f helm-app-template/helmvalues/values.yaml \
  -n floodgate
```

**Upgrade after a new image or values change:**

```bash
helm upgrade floodgate ./helm-app-template \
  -f helm-app-template/helmvalues/values.yaml \
  -n floodgate
```

Default credentials: `admin` / `admin` — password change is required on first login.

#### Exposing the app

The Helm chart supports two ingress options — enable only one:

**Ingress Nginx**

```yaml
# helm-app-template/helmvalues/values.yaml
ingress:
  enabled: true
  className: nginx
  hostnames:
    - floodgate.example.com
  tls:
    enabled: true
    clusterIssuer: letsencrypt-prod
```

**Gateway API**

```yaml
gateway:
  enabled: true          # create the shared Gateway (once per cluster)
  gatewayClassName: nginx

httproute:
  enabled: true
  hostnames:
    - floodgate.example.com
```

---

### Development (local)

**Prerequisites:** Node.js 20+, `kubectl` pointed at any cluster (kind, DOKS, etc.).

```bash
npm install
make dev   # → http://localhost:3000
```

Uses `~/.kube/config` directly. No Docker required. File changes reload in under 1 s.

---

### Integration tests (kind)

Requires the app running and a port-forward active:

```bash
# Terminal 1 — keep running
kubectl port-forward svc/floodgate 3000:3000 -n floodgate

# Terminal 2 — deploy test apps (once)
kubectl apply -f test-apps/

# Run all scenarios (pass your password if already changed from default)
./test-apps/full-test.sh                              # admin / admin
./test-apps/full-test.sh http://localhost:3000 admin YOUR_PASSWORD

# Run a single connectivity scenario
./test-apps/run-tests.sh baseline
./test-apps/run-tests.sh isolate-database
```

---

## Roles

| Role | Description |
|------|-------------|
| `admin` | Full access — create/delete policies, manage users, change config |
| `ns_admin` | Same as admin but only in assigned namespaces |
| `viewer` | Read-only — sees the graph and policies |
| `audit` | Can read policies and the audit log; no mutations |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | `floodgate-secret-change-me` | HS256 signing key — **required in production** |
| `DB_PATH` | `floodgate-dev.db` (dev) / `/data/floodgate.db` (prod) | SQLite file path |

---

## Tech stack

- **Next.js 15** (App Router, TypeScript) — frontend + API in one binary
- **@xyflow/react** — interactive graph canvas
- **@kubernetes/client-node** — K8s API (server-only, uses in-cluster ServiceAccount)
- **better-sqlite3** — embedded database, no external dependencies
- **jose / bcryptjs** — JWT HS256 auth + password hashing

---

Created by **José Lucas** · [LinkedIn](https://www.linkedin.com/in/lucasaffonso0/)
