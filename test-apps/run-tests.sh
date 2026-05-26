#!/usr/bin/env bash
# Floodgate NetworkPolicy Test Suite
# Usage: ./run-tests.sh [scenario]
#
# Tests run FROM the actual application pods (app, worker, haproxy, pgbouncer, grafana)
# so that Floodgate's podSelector-based allow rules are exercised correctly.
#
# Topology (traffic-sim.yaml):
#   frontend/app       port 80+443
#   backend/worker     port 8080
#   infra/haproxy      port 80
#   database/pgbouncer port 6432
#   monitoring/grafana port 3000
#
# Scenarios:
#   baseline                    — No policies, everything OPEN
#   restrict-db-ingress         — restrict-ingress on database/pgbouncer
#   allow-backend-to-db         — restrict-ingress pgbouncer + allow worker→pgbouncer
#   restrict-frontend-egress    — restrict-egress on frontend/app
#   allow-egress-internet       — restrict-egress frontend + internet egress (80/443)
#   isolate-database-allow-backend — namespace-isolate database (ingress) + allow worker→pgbouncer
#   isolate-database            — full namespace isolation (both directions, no intra)
#   isolate-database-intra      — full isolation + intra-namespace allow
#   allow-ns-monitoring         — restrict-ingress worker + allow namespace monitoring→worker
#   restrict-db-egress-allow-backend — restrict-egress pgbouncer + allow egress pgbouncer→worker
#   isolate-db-egress-allow-backend  — namespace-isolate database egress + allow pgbouncer→worker
#   restrict-multiple           — restrict-ingress pgbouncer AND worker simultaneously
#   protocol-tcp-explicit       — allow TCP explicit port
#   protocol-udp-blocks-tcp     — UDP-only allow does not unblock TCP
#   protocol-multiport          — multi-port TCP+UDP allow
#   scan                        — scan and display current connectivity state

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

PASS=0; FAIL=0; SKIP=0
TIMEOUT=4

# ── Parallel check engine ─────────────────────────────────────────────────────
WORK_DIR=$(mktemp -d)
SEQ=0
trap 'rm -rf "$WORK_DIR"' EXIT

# Spawns a background connectivity check.
# Writes structured result to $WORK_DIR/<seq> — flush() reads them in order.
# Result format: STATUS|from_ns|from_app|target_label|actual|expected
check() {
  local from_ns=$1 from_app=$2 target=$3 expected=${4:-""}
  SEQ=$((SEQ + 1))
  local seq=$SEQ
  local result_file
  result_file=$(printf '%s/%06d' "$WORK_DIR" "$seq")
  local label="${target##http*://}"   # strip protocol for display

  (
    local pod
    pod=$(kubectl get pod -n "$from_ns" -l app="$from_app" \
      -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' 2>/dev/null \
      | awk '{print $1}')

    if [ -z "$pod" ]; then
      printf 'SKIP|%s|%s|%s||%s\n' "$from_ns" "$from_app" "$label" "$expected" > "$result_file"
      return
    fi

    local actual="BLOCKED"
    if kubectl exec -n "$from_ns" "$pod" -- \
         wget -qT "$TIMEOUT" -O /dev/null "$target" > /dev/null 2>&1; then
      actual="OPEN"
    fi

    printf '%s|%s|%s|%s|%s|%s\n' \
      "${expected:+$([ "$actual" = "$expected" ] && echo PASS || echo FAIL)}" \
      "$from_ns" "$from_app" "$label" "$actual" "$expected" > "$result_file"

    # scan mode (no expected) — store actual as status
    if [ -z "$expected" ]; then
      printf '%s|%s|%s|%s|%s|\n' "$actual" "$from_ns" "$from_app" "$label" "$actual" > "$result_file"
    fi
  ) &
}

# Waits for all background checks, prints results in spawn order, accumulates counts.
flush() {
  wait
  for f in $(ls "$WORK_DIR" 2>/dev/null | sort); do
    local fp="$WORK_DIR/$f"
    local status from_ns from_app label actual expected
    IFS='|' read -r status from_ns from_app label actual expected < "$fp"
    local src="${CYAN}${from_ns}/${from_app}${NC}"

    case "$status" in
      PASS)
        echo -e "  ${GREEN}✓ PASS ${NC} $src → $label = ${BOLD}$actual${NC}"
        PASS=$((PASS + 1)) ;;
      FAIL)
        echo -e "  ${RED}✗ FAIL ${NC} $src → $label = ${BOLD}$actual${NC}  ${RED}(esperado $expected)${NC}"
        FAIL=$((FAIL + 1)) ;;
      SKIP)
        echo -e "  ${YELLOW}SKIP   ${NC} $src → $label  ${YELLOW}(pod não encontrado)${NC}"
        SKIP=$((SKIP + 1)) ;;
      OPEN)
        echo -e "  ${GREEN}OPEN   ${NC} $src → $label" ;;
      BLOCKED)
        echo -e "  ${RED}BLOCKED${NC} $src → $label" ;;
    esac

    rm -f "$fp"
  done
}

separator() { echo -e "${BLUE}────────────────────────────────────────────────────────${NC}"; }

# flush() antes de imprimir o próximo cabeçalho — mantém ordem com paralelismo
header() {
  flush
  echo -e "\n${BOLD}$1${NC}"
  separator
}

print_summary() {
  flush
  local title="${1:-Resultado}"
  echo ""
  separator
  echo -e "${BOLD}$title${NC}"
  separator
  if [ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]; then
    echo -e "  ${GREEN}${BOLD}ALL TESTS PASSED${NC}  ✓  ($PASS passed, $SKIP skipped)"
  elif [ "$FAIL" -gt 0 ]; then
    echo -e "  ${RED}${BOLD}TESTS FAILED${NC}  ✗  ($FAIL failed, $PASS passed, $SKIP skipped)"
  else
    echo -e "  ${YELLOW}Scan completo${NC} ($SKIP skipped)"
  fi
  separator
  echo ""
}

wait_pods() {
  echo -e "${YELLOW}Aguardando pods ficarem Ready...${NC}"
  kubectl wait --for=condition=Ready pod -l app=app       -n frontend   --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=worker    -n backend    --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=haproxy   -n infra      --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=pgbouncer -n database   --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=grafana   -n monitoring --timeout=60s 2>/dev/null || true
  echo ""
}

# ── Targets ───────────────────────────────────────────────────────────────────
FRONTEND="http://app.frontend.svc.cluster.local:80"
BACKEND="http://worker.backend.svc.cluster.local:8080"
INFRA="http://haproxy.infra.svc.cluster.local:80"
DATABASE="http://pgbouncer.database.svc.cluster.local:6432"
MONITORING="http://grafana.monitoring.svc.cluster.local:3000"
INTERNET="http://1.1.1.1"

# ── Scenarios ─────────────────────────────────────────────────────────────────

scenario_baseline() {
  echo -e "\n${BOLD}${BLUE}Cenário: BASELINE — Sem policies, tudo OPEN${NC}"
  separator

  header "FROM: frontend/app"
  check frontend app "$BACKEND"    OPEN
  check frontend app "$INFRA"      OPEN
  check frontend app "$DATABASE"   OPEN
  check frontend app "$MONITORING" OPEN
  check frontend app "$INTERNET"   OPEN

  header "FROM: backend/worker"
  check backend worker "$FRONTEND"   OPEN
  check backend worker "$INFRA"      OPEN
  check backend worker "$DATABASE"   OPEN
  check backend worker "$MONITORING" OPEN
  check backend worker "$INTERNET"   OPEN

  header "FROM: infra/haproxy"
  check infra haproxy "$FRONTEND"   OPEN
  check infra haproxy "$BACKEND"    OPEN
  check infra haproxy "$DATABASE"   OPEN
  check infra haproxy "$MONITORING" OPEN
  check infra haproxy "$INTERNET"   OPEN

  header "FROM: database/pgbouncer"
  check database pgbouncer "$FRONTEND"   OPEN
  check database pgbouncer "$BACKEND"    OPEN
  check database pgbouncer "$INFRA"      OPEN
  check database pgbouncer "$MONITORING" OPEN
  check database pgbouncer "$INTERNET"   OPEN

  header "FROM: monitoring/grafana"
  check monitoring grafana "$FRONTEND"  OPEN
  check monitoring grafana "$BACKEND"   OPEN
  check monitoring grafana "$INFRA"     OPEN
  check monitoring grafana "$DATABASE"  OPEN
  check monitoring grafana "$INTERNET"  OPEN

  print_summary "Resultado Baseline"
}

scenario_restrict_db_ingress() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-ingress em database/pgbouncer${NC}"
  separator

  header "Ingresso bloqueado para database/pgbouncer"
  check frontend   app      "$DATABASE" BLOCKED
  check backend    worker   "$DATABASE" BLOCKED
  check infra      haproxy  "$DATABASE" BLOCKED
  check monitoring grafana  "$DATABASE" BLOCKED

  header "Outras conexões não afetadas"
  check frontend app    "$BACKEND"    OPEN
  check frontend app    "$MONITORING" OPEN
  check backend  worker "$INFRA"      OPEN

  header "Egress de pgbouncer ainda funciona"
  check database pgbouncer "$BACKEND"  OPEN
  check database pgbouncer "$INTERNET" OPEN

  print_summary "Resultado: restrict-ingress em database/pgbouncer"
}

scenario_allow_backend_to_db() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-ingress pgbouncer + allow backend/worker → database/pgbouncer${NC}"
  separator

  header "Somente backend/worker pode acessar database/pgbouncer"
  check backend    worker   "$DATABASE" OPEN
  check frontend   app      "$DATABASE" BLOCKED
  check infra      haproxy  "$DATABASE" BLOCKED
  check monitoring grafana  "$DATABASE" BLOCKED

  print_summary "Resultado: allow worker→pgbouncer"
}

scenario_restrict_frontend_egress() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-egress em frontend/app${NC}"
  separator

  header "Egress de frontend/app bloqueado"
  check frontend app "$BACKEND"    BLOCKED
  check frontend app "$DATABASE"   BLOCKED
  check frontend app "$INFRA"      BLOCKED
  check frontend app "$MONITORING" BLOCKED
  check frontend app "$INTERNET"   BLOCKED

  header "Ingress para frontend/app ainda funciona"
  check backend    worker   "$FRONTEND" OPEN
  check monitoring grafana  "$FRONTEND" OPEN
  check infra      haproxy  "$FRONTEND" OPEN

  print_summary "Resultado: restrict-egress em frontend/app"
}

scenario_allow_egress_internet() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-egress em frontend + internet egress (80/443)${NC}"
  separator

  header "Internet acessível (port 80)"
  check frontend app "$INTERNET" OPEN

  header "Rede interna ainda bloqueada"
  check frontend app "$BACKEND"    BLOCKED
  check frontend app "$DATABASE"   BLOCKED
  check frontend app "$MONITORING" BLOCKED

  print_summary "Resultado: internet egress no frontend/app"
}

scenario_isolate_database_allow_backend() {
  echo -e "\n${BOLD}${BLUE}Cenário: namespace-isolate database (ingress) + allow backend/worker → database/pgbouncer${NC}"
  separator

  header "Somente backend/worker acessa database/pgbouncer"
  check backend    worker   "$DATABASE" OPEN
  check frontend   app      "$DATABASE" BLOCKED
  check infra      haproxy  "$DATABASE" BLOCKED
  check monitoring grafana  "$DATABASE" BLOCKED

  header "Egress de pgbouncer ainda funciona (só ingress isolado)"
  check database pgbouncer "$BACKEND"  OPEN
  check database pgbouncer "$INTERNET" OPEN

  print_summary "Resultado: namespace-isolate database + allow worker→pgbouncer"
}

scenario_isolate_database() {
  echo -e "\n${BOLD}${BLUE}Cenário: isolamento total do namespace database${NC}"
  separator

  header "Ingresso bloqueado de todos os namespaces"
  check frontend   app      "$DATABASE" BLOCKED
  check backend    worker   "$DATABASE" BLOCKED
  check infra      haproxy  "$DATABASE" BLOCKED
  check monitoring grafana  "$DATABASE" BLOCKED

  header "Egress de pgbouncer bloqueado"
  check database pgbouncer "$FRONTEND"   BLOCKED
  check database pgbouncer "$BACKEND"    BLOCKED
  check database pgbouncer "$INFRA"      BLOCKED
  check database pgbouncer "$MONITORING" BLOCKED
  check database pgbouncer "$INTERNET"   BLOCKED

  print_summary "Resultado: isolamento total database"
}

scenario_isolate_database_intra() {
  echo -e "\n${BOLD}${BLUE}Cenário: isolamento database + tráfego interno liberado${NC}"
  separator

  header "Externo ainda bloqueado"
  check frontend   app      "$DATABASE" BLOCKED
  check backend    worker   "$DATABASE" BLOCKED
  check infra      haproxy  "$DATABASE" BLOCKED
  check monitoring grafana  "$DATABASE" BLOCKED

  header "Intra-namespace database/pgbouncer → pgbouncer service OPEN"
  check database pgbouncer "$DATABASE" OPEN

  header "Egress para fora do namespace bloqueado"
  check database pgbouncer "$BACKEND"  BLOCKED
  check database pgbouncer "$INTERNET" BLOCKED

  print_summary "Resultado: isolamento com intra-namespace liberado"
}

scenario_allow_ns_monitoring() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-ingress worker + allow namespace monitoring → backend/worker${NC}"
  separator

  header "monitoring pode acessar backend/worker"
  check monitoring grafana "$BACKEND" OPEN

  header "Outros namespaces ainda bloqueados em backend/worker"
  check frontend   app      "$BACKEND" BLOCKED
  check infra      haproxy  "$BACKEND" BLOCKED
  check database   pgbouncer "$BACKEND" BLOCKED

  print_summary "Resultado: allow namespace monitoring→backend/worker"
}

scenario_restrict_db_egress_allow_backend() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-egress em database/pgbouncer + allow egress pgbouncer → backend/worker${NC}"
  separator

  header "Egress de pgbouncer bloqueado (exceto backend/worker)"
  check database pgbouncer "$BACKEND"    OPEN
  check database pgbouncer "$FRONTEND"   BLOCKED
  check database pgbouncer "$MONITORING" BLOCKED
  check database pgbouncer "$INTERNET"   BLOCKED

  header "Ingress para database/pgbouncer não afetado (egress não restringe ingress)"
  check backend    worker  "$DATABASE" OPEN
  check frontend   app     "$DATABASE" OPEN
  check monitoring grafana "$DATABASE" OPEN

  print_summary "Resultado: restrict-egress pgbouncer + allow egress pgbouncer→worker"
}

scenario_isolate_db_egress_allow_backend() {
  echo -e "\n${BOLD}${BLUE}Cenário: namespace-isolate database (egress) + allow egress pgbouncer → backend/worker${NC}"
  separator

  header "Somente pgbouncer pode sair para backend/worker"
  check database pgbouncer "$BACKEND"    OPEN
  check database pgbouncer "$FRONTEND"   BLOCKED
  check database pgbouncer "$MONITORING" BLOCKED
  check database pgbouncer "$INTERNET"   BLOCKED

  header "Ingresso no namespace database não afetado"
  check backend    worker  "$DATABASE" OPEN
  check frontend   app     "$DATABASE" OPEN
  check monitoring grafana "$DATABASE" OPEN

  print_summary "Resultado: namespace-isolate database egress + allow pgbouncer→worker"
}

scenario_restrict_multiple() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-ingress em database/pgbouncer E backend/worker simultaneamente${NC}"
  separator

  header "database/pgbouncer bloqueado para todos"
  check frontend   app      "$DATABASE" BLOCKED
  check backend    worker   "$DATABASE" BLOCKED
  check monitoring grafana  "$DATABASE" BLOCKED

  header "backend/worker bloqueado para todos"
  check frontend   app      "$BACKEND"  BLOCKED
  check infra      haproxy  "$BACKEND"  BLOCKED
  check monitoring grafana  "$BACKEND"  BLOCKED

  header "Outros serviços não afetados"
  check frontend   app      "$MONITORING" OPEN
  check frontend   app      "$INFRA"      OPEN
  check database   pgbouncer "$FRONTEND"  OPEN
  check database   pgbouncer "$INTERNET"  OPEN

  print_summary "Resultado: restrict-ingress múltiplos serviços"
}

scenario_scan() {
  echo -e "\n${BOLD}${BLUE}Scan — estado atual de conectividade${NC}"
  separator

  header "FROM: frontend/app"
  check frontend app "$BACKEND"
  check frontend app "$INFRA"
  check frontend app "$DATABASE"
  check frontend app "$MONITORING"
  check frontend app "$INTERNET"

  header "FROM: backend/worker"
  check backend worker "$FRONTEND"
  check backend worker "$INFRA"
  check backend worker "$DATABASE"
  check backend worker "$MONITORING"
  check backend worker "$INTERNET"

  header "FROM: infra/haproxy"
  check infra haproxy "$FRONTEND"
  check infra haproxy "$BACKEND"
  check infra haproxy "$DATABASE"
  check infra haproxy "$MONITORING"
  check infra haproxy "$INTERNET"

  header "FROM: database/pgbouncer"
  check database pgbouncer "$FRONTEND"
  check database pgbouncer "$BACKEND"
  check database pgbouncer "$MONITORING"
  check database pgbouncer "$INTERNET"

  header "FROM: monitoring/grafana"
  check monitoring grafana "$FRONTEND"
  check monitoring grafana "$BACKEND"
  check monitoring grafana "$INFRA"
  check monitoring grafana "$DATABASE"
  check monitoring grafana "$INTERNET"

  flush
  echo ""
  separator
  echo -e "  Scan completo. ${GREEN}Verde${NC} = tráfego passando, ${RED}Vermelho${NC} = bloqueado/timeout."
  separator
  echo ""
}

scenario_protocol_tcp_explicit() {
  echo -e "\n${BOLD}${BLUE}Cenário: policy com protocol: TCP explícito — worker → database/pgbouncer${NC}"
  separator

  header "TCP explícito: backend/worker acessa database/pgbouncer"
  check backend    worker   "$DATABASE" OPEN
  check frontend   app      "$DATABASE" BLOCKED
  check infra      haproxy  "$DATABASE" BLOCKED
  check monitoring grafana  "$DATABASE" BLOCKED

  header "Outros tráfegos não afetados"
  check backend worker "$BACKEND"    OPEN
  check backend worker "$MONITORING" OPEN

  print_summary "Resultado: allow TCP explícito worker→pgbouncer"
}

scenario_protocol_udp_blocks_tcp() {
  echo -e "\n${BOLD}${BLUE}Cenário: policy UDP-only não libera TCP — restrict-ingress + allow UDP 5000${NC}"
  separator

  header "TCP para database/pgbouncer continua bloqueado (allow só cobre UDP 5000)"
  check frontend   app      "$DATABASE" BLOCKED
  check backend    worker   "$DATABASE" BLOCKED
  check infra      haproxy  "$DATABASE" BLOCKED
  check monitoring grafana  "$DATABASE" BLOCKED

  header "database/pgbouncer egress não afetado (restrict só é ingress)"
  check database pgbouncer "$BACKEND"  OPEN
  check database pgbouncer "$INTERNET" OPEN

  print_summary "Resultado: UDP-only allow não libera TCP"
}

scenario_protocol_multiport() {
  echo -e "\n${BOLD}${BLUE}Cenário: policy multi-porta TCP+UDP — restrict-ingress + allow TCP 6432 + UDP 5000${NC}"
  separator

  header "backend/worker acessa database/pgbouncer via TCP (coberto pela porta 6432)"
  check backend    worker   "$DATABASE" OPEN
  check frontend   app      "$DATABASE" BLOCKED
  check infra      haproxy  "$DATABASE" BLOCKED
  check monitoring grafana  "$DATABASE" BLOCKED

  print_summary "Resultado: allow multi-porta TCP+UDP worker→pgbouncer"
}

# ── Main ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║     Floodgate — NetworkPolicy Test Suite           ║${NC}"
echo -e "${BOLD}${BLUE}╚════════════════════════════════════════════════════╝${NC}"

SCENARIO=${1:-scan}

wait_pods

case $SCENARIO in
  baseline)                          scenario_baseline ;;
  restrict-db-ingress)               scenario_restrict_db_ingress ;;
  allow-backend-to-db)               scenario_allow_backend_to_db ;;
  restrict-frontend-egress)          scenario_restrict_frontend_egress ;;
  allow-egress-internet)             scenario_allow_egress_internet ;;
  isolate-database-allow-backend)    scenario_isolate_database_allow_backend ;;
  isolate-database)                  scenario_isolate_database ;;
  isolate-database-intra)            scenario_isolate_database_intra ;;
  allow-ns-monitoring)               scenario_allow_ns_monitoring ;;
  restrict-db-egress-allow-backend)  scenario_restrict_db_egress_allow_backend ;;
  isolate-db-egress-allow-backend)   scenario_isolate_db_egress_allow_backend ;;
  restrict-multiple)                 scenario_restrict_multiple ;;
  protocol-tcp-explicit)             scenario_protocol_tcp_explicit ;;
  protocol-udp-blocks-tcp)           scenario_protocol_udp_blocks_tcp ;;
  protocol-multiport)                scenario_protocol_multiport ;;
  scan|*)                            scenario_scan ;;
esac

exit $((FAIL > 0 ? 1 : 0))
