#!/usr/bin/env bash
# Floodgate NetworkPolicy Test Suite
# Usage: ./run-tests.sh [scenario]
#
# Tests run FROM the actual application pods (nginx, httpd, db, metrics) so that
# Floodgate's podSelector-based allow rules are exercised correctly.
# infra/whoami (nginx:alpine) usado como source de infra
#
# Scenarios:
#   baseline              — Nenhuma policy, tudo deve ser OPEN
#   restrict-db-ingress   — restrict-ingress aplicado em database/db
#   allow-backend-to-db   — allow ingress de backend/httpd → database/db (restrict ainda ativo)
#   restrict-frontend-egress — restrict-egress em frontend/nginx
#   allow-egress-internet — restrict-egress em frontend + internet egress liberado (80/443)
#   isolate-database      — namespace database completamente isolado (sem intra-namespace)
#   isolate-database-intra — namespace database isolado + tráfego interno liberado
#   allow-ns-monitoring   — allow namespace monitoring → backend/httpd
#   scan                  — apenas escaneia e mostra estado atual (sem expected)

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
  kubectl wait --for=condition=Ready pod -l app=nginx       -n frontend  --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=httpd       -n backend   --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=whoami      -n infra     --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=db          -n database  --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=db-replica  -n database  --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=metrics     -n monitoring --timeout=60s 2>/dev/null || true
  kubectl wait --for=condition=Ready pod -l app=alertmanager -n monitoring --timeout=60s 2>/dev/null || true
  echo ""
}

# ── Targets ───────────────────────────────────────────────────────────────────
FRONTEND="http://nginx.frontend.svc.cluster.local:8080"
BACKEND="http://httpd.backend.svc.cluster.local:8081"
INFRA="http://whoami.infra.svc.cluster.local:80"
DATABASE="http://db.database.svc.cluster.local:5432"
DB_REPLICA="http://db-replica.database.svc.cluster.local:5432"
MONITORING="http://metrics.monitoring.svc.cluster.local:9090"
ALERTMGR="http://alertmanager.monitoring.svc.cluster.local:9093"
INTERNET="http://1.1.1.1"

# ── Scenarios ─────────────────────────────────────────────────────────────────

scenario_baseline() {
  echo -e "\n${BOLD}${BLUE}Cenário: BASELINE — Sem policies, tudo OPEN${NC}"
  separator

  header "FROM: frontend/nginx"
  check frontend nginx "$BACKEND"    OPEN
  check frontend nginx "$INFRA"      OPEN
  check frontend nginx "$DATABASE"   OPEN
  check frontend nginx "$MONITORING" OPEN
  check frontend nginx "$INTERNET"   OPEN

  header "FROM: backend/httpd"
  check backend httpd "$FRONTEND"   OPEN
  check backend httpd "$INFRA"      OPEN
  check backend httpd "$DATABASE"   OPEN
  check backend httpd "$MONITORING" OPEN
  check backend httpd "$INTERNET"   OPEN

  header "FROM: infra/whoami"
  check infra whoami "$FRONTEND"   OPEN
  check infra whoami "$BACKEND"    OPEN
  check infra whoami "$DATABASE"   OPEN
  check infra whoami "$MONITORING" OPEN
  check infra whoami "$INTERNET"   OPEN

  header "FROM: database/db"
  check database db "$FRONTEND"    OPEN
  check database db "$BACKEND"     OPEN
  check database db "$INFRA"       OPEN
  check database db "$DB_REPLICA"  OPEN
  check database db "$MONITORING"  OPEN
  check database db "$INTERNET"    OPEN

  header "FROM: monitoring/metrics"
  check monitoring metrics "$FRONTEND"  OPEN
  check monitoring metrics "$BACKEND"   OPEN
  check monitoring metrics "$INFRA"     OPEN
  check monitoring metrics "$DATABASE"  OPEN
  check monitoring metrics "$ALERTMGR"  OPEN
  check monitoring metrics "$INTERNET"  OPEN

  print_summary "Resultado Baseline"
}

scenario_restrict_db_ingress() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-ingress em database/db${NC}"
  separator

  header "Ingresso bloqueado para database/db"
  check frontend   nginx    "$DATABASE" BLOCKED
  check backend    httpd    "$DATABASE" BLOCKED
  check infra      whoami   "$DATABASE" BLOCKED
  check monitoring metrics  "$DATABASE" BLOCKED

  header "Outras conexões não afetadas"
  check frontend nginx    "$BACKEND"    OPEN
  check frontend nginx    "$MONITORING" OPEN
  check backend  httpd    "$INFRA"      OPEN

  header "Egress de database/db ainda funciona"
  check database db "$BACKEND"  OPEN
  check database db "$INTERNET" OPEN

  print_summary "Resultado: restrict-ingress em database/db"
}

scenario_allow_backend_to_db() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-ingress db + allow backend/httpd → database/db${NC}"
  separator

  header "Somente backend/httpd pode acessar database/db"
  check backend    httpd   "$DATABASE" OPEN
  check frontend   nginx   "$DATABASE" BLOCKED
  check infra      whoami  "$DATABASE" BLOCKED
  check monitoring metrics "$DATABASE" BLOCKED

  header "db-replica sem policy — permanece acessível"
  check backend httpd "$DB_REPLICA" OPEN

  print_summary "Resultado: allow backend/httpd→database/db"
}

scenario_restrict_frontend_egress() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-egress em frontend/nginx${NC}"
  separator

  header "Egress de frontend/nginx bloqueado"
  check frontend nginx "$BACKEND"    BLOCKED
  check frontend nginx "$DATABASE"   BLOCKED
  check frontend nginx "$INFRA"      BLOCKED
  check frontend nginx "$MONITORING" BLOCKED
  check frontend nginx "$INTERNET"   BLOCKED

  header "Ingress para frontend/nginx ainda funciona"
  check backend    httpd   "$FRONTEND" OPEN
  check monitoring metrics "$FRONTEND" OPEN
  check infra      whoami  "$FRONTEND" OPEN

  print_summary "Resultado: restrict-egress em frontend/nginx"
}

scenario_allow_egress_internet() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-egress em frontend + internet egress (80/443)${NC}"
  separator

  header "Internet acessível (port 80)"
  check frontend nginx "$INTERNET" OPEN

  header "Rede interna ainda bloqueada"
  check frontend nginx "$BACKEND"    BLOCKED
  check frontend nginx "$DATABASE"   BLOCKED
  check frontend nginx "$MONITORING" BLOCKED

  print_summary "Resultado: internet egress no frontend/nginx"
}

scenario_isolate_database_allow_backend() {
  echo -e "\n${BOLD}${BLUE}Cenário: namespace-isolate database + allow backend/httpd → database/db${NC}"
  separator

  header "Somente backend/httpd acessa database/db"
  check backend    httpd   "$DATABASE" OPEN
  check frontend   nginx   "$DATABASE" BLOCKED
  check infra      whoami  "$DATABASE" BLOCKED
  check monitoring metrics "$DATABASE" BLOCKED

  header "db-replica sem allow específico — permanece bloqueada"
  check backend httpd "$DB_REPLICA" BLOCKED

  header "Egress de database/db ainda funciona (só ingress isolado)"
  check database db "$BACKEND"  OPEN
  check database db "$INTERNET" OPEN

  print_summary "Resultado: namespace-isolate database + allow backend→db"
}

scenario_isolate_database() {
  echo -e "\n${BOLD}${BLUE}Cenário: isolamento total do namespace database${NC}"
  separator

  header "Ingresso bloqueado de todos os namespaces"
  check frontend   nginx    "$DATABASE" BLOCKED
  check backend    httpd    "$DATABASE" BLOCKED
  check infra      whoami   "$DATABASE" BLOCKED
  check monitoring metrics  "$DATABASE" BLOCKED

  header "Egress de database/db bloqueado"
  check database db "$FRONTEND"   BLOCKED
  check database db "$BACKEND"    BLOCKED
  check database db "$INFRA"      BLOCKED
  check database db "$MONITORING" BLOCKED
  check database db "$INTERNET"   BLOCKED

  header "Intra-namespace também bloqueado (sem allow-intra)"
  check database db "$DB_REPLICA" BLOCKED

  print_summary "Resultado: isolamento total database"
}

scenario_isolate_database_intra() {
  echo -e "\n${BOLD}${BLUE}Cenário: isolamento database + tráfego interno liberado${NC}"
  separator

  header "Externo ainda bloqueado"
  check frontend   nginx    "$DATABASE" BLOCKED
  check backend    httpd    "$DATABASE" BLOCKED
  check infra      whoami   "$DATABASE" BLOCKED
  check monitoring metrics  "$DATABASE" BLOCKED

  header "Intra-namespace database/db → database OPEN"
  check database db "$DB_REPLICA" OPEN
  check database db "$DATABASE"   OPEN

  header "Egress para fora do namespace bloqueado"
  check database db "$BACKEND"  BLOCKED
  check database db "$INTERNET" BLOCKED

  print_summary "Resultado: isolamento com intra-namespace liberado"
}

scenario_allow_ns_monitoring() {
  echo -e "\n${BOLD}${BLUE}Cenário: allow namespace monitoring → backend/httpd${NC}"
  separator

  header "monitoring pode acessar backend/httpd"
  check monitoring metrics    "$BACKEND"  OPEN
  check monitoring alertmanager "$ALERTMGR" OPEN

  header "Outros namespaces ainda bloqueados em backend/httpd"
  check frontend nginx  "$BACKEND" BLOCKED
  check infra    whoami "$BACKEND" BLOCKED
  check database db     "$BACKEND" BLOCKED

  print_summary "Resultado: allow namespace monitoring→backend/httpd"
}

scenario_scan() {
  echo -e "\n${BOLD}${BLUE}Scan — estado atual de conectividade${NC}"
  separator

  header "FROM: frontend/nginx"
  check frontend nginx "$BACKEND"
  check frontend nginx "$INFRA"
  check frontend nginx "$DATABASE"
  check frontend nginx "$MONITORING"
  check frontend nginx "$INTERNET"

  header "FROM: backend/httpd"
  check backend httpd "$FRONTEND"
  check backend httpd "$INFRA"
  check backend httpd "$DATABASE"
  check backend httpd "$MONITORING"
  check backend httpd "$INTERNET"

  header "FROM: infra/whoami"
  check infra whoami "$FRONTEND"
  check infra whoami "$BACKEND"
  check infra whoami "$DATABASE"
  check infra whoami "$MONITORING"
  check infra whoami "$INTERNET"

  header "FROM: database/db"
  check database db "$FRONTEND"
  check database db "$BACKEND"
  check database db "$DB_REPLICA"
  check database db "$MONITORING"
  check database db "$INTERNET"

  header "FROM: monitoring/metrics"
  check monitoring metrics "$FRONTEND"
  check monitoring metrics "$BACKEND"
  check monitoring metrics "$INFRA"
  check monitoring metrics "$DATABASE"
  check monitoring metrics "$ALERTMGR"
  check monitoring metrics "$INTERNET"

  flush
  echo ""
  separator
  echo -e "  Scan completo. ${GREEN}Verde${NC} = tráfego passando, ${RED}Vermelho${NC} = bloqueado/timeout."
  separator
  echo ""
}

scenario_restrict_db_egress_allow_backend() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-egress em database/db + allow egress db → backend/httpd${NC}"
  separator

  header "Egress de database/db bloqueado (exceto backend/httpd)"
  check database db "$BACKEND"    OPEN
  check database db "$FRONTEND"   BLOCKED
  check database db "$MONITORING" BLOCKED
  check database db "$INTERNET"   BLOCKED

  header "Ingress para database/db não afetado (egress não restringe ingress)"
  check backend    httpd   "$DATABASE" OPEN
  check frontend   nginx   "$DATABASE" OPEN
  check monitoring metrics "$DATABASE" OPEN

  print_summary "Resultado: restrict-egress db + allow egress db→backend"
}

scenario_isolate_db_egress_allow_backend() {
  echo -e "\n${BOLD}${BLUE}Cenário: namespace-isolate database (egress) + allow egress db → backend/httpd${NC}"
  separator

  header "Somente database/db pode sair para backend/httpd"
  check database db "$BACKEND"    OPEN
  check database db "$FRONTEND"   BLOCKED
  check database db "$MONITORING" BLOCKED
  check database db "$INTERNET"   BLOCKED

  header "Ingresso no namespace database não afetado"
  check backend    httpd   "$DATABASE" OPEN
  check frontend   nginx   "$DATABASE" OPEN
  check monitoring metrics "$DATABASE" OPEN

  header "Intra-namespace database também bloqueado (egress isolado, sem intra-allow)"
  check database db "$DB_REPLICA" BLOCKED

  print_summary "Resultado: namespace-isolate database egress + allow db→backend"
}

scenario_protocol_tcp_explicit() {
  echo -e "\n${BOLD}${BLUE}Cenário: policy com protocol: TCP explícito — httpd → database/db${NC}"
  separator

  header "TCP explícito: backend/httpd acessa database/db"
  check backend    httpd   "$DATABASE" OPEN
  check frontend   nginx   "$DATABASE" BLOCKED
  check infra      whoami  "$DATABASE" BLOCKED
  check monitoring metrics "$DATABASE" BLOCKED

  header "Outros tráfegos não afetados"
  check backend httpd "$BACKEND"   OPEN
  check backend httpd "$MONITORING" OPEN

  print_summary "Resultado: allow TCP explícito httpd→db"
}

scenario_protocol_udp_blocks_tcp() {
  echo -e "\n${BOLD}${BLUE}Cenário: policy UDP-only não libera TCP — restrict-ingress + allow UDP 5000${NC}"
  separator

  header "TCP para database/db continua bloqueado (allow só cobre UDP 5000)"
  check frontend   nginx   "$DATABASE" BLOCKED
  check backend    httpd   "$DATABASE" BLOCKED
  check infra      whoami  "$DATABASE" BLOCKED
  check monitoring metrics "$DATABASE" BLOCKED

  header "database/db egress não afetado (restrict só é ingress)"
  check database db "$BACKEND"  OPEN
  check database db "$INTERNET" OPEN

  print_summary "Resultado: UDP-only allow não libera TCP"
}

scenario_protocol_multiport() {
  echo -e "\n${BOLD}${BLUE}Cenário: policy multi-porta TCP+UDP — restrict-ingress + allow TCP 5432 + UDP 5000${NC}"
  separator

  header "backend/httpd acessa database/db via TCP (HTTP coberto pela porta 5432)"
  check backend    httpd   "$DATABASE" OPEN
  check frontend   nginx   "$DATABASE" BLOCKED
  check infra      whoami  "$DATABASE" BLOCKED
  check monitoring metrics "$DATABASE" BLOCKED

  print_summary "Resultado: allow multi-porta TCP+UDP httpd→db"
}

scenario_restrict_multiple() {
  echo -e "\n${BOLD}${BLUE}Cenário: restrict-ingress em database/db E backend/httpd simultaneamente${NC}"
  separator

  header "database/db bloqueado para todos"
  check frontend   nginx   "$DATABASE" BLOCKED
  check backend    httpd   "$DATABASE" BLOCKED
  check monitoring metrics "$DATABASE" BLOCKED

  header "backend/httpd bloqueado para todos"
  check frontend   nginx   "$BACKEND"  BLOCKED
  check infra      whoami  "$BACKEND"  BLOCKED
  check monitoring metrics "$BACKEND"  BLOCKED

  header "Outros serviços não afetados"
  check frontend nginx    "$MONITORING" OPEN
  check frontend nginx    "$INFRA"      OPEN
  check database db       "$FRONTEND"   OPEN
  check database db       "$INTERNET"   OPEN

  print_summary "Resultado: restrict-ingress múltiplos serviços"
}

# ── Main ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║     Floodgate — NetworkPolicy Test Suite           ║${NC}"
echo -e "${BOLD}${BLUE}╚════════════════════════════════════════════════════╝${NC}"

SCENARIO=${1:-scan}

wait_pods

case $SCENARIO in
  baseline)                 scenario_baseline ;;
  restrict-db-ingress)      scenario_restrict_db_ingress ;;
  allow-backend-to-db)      scenario_allow_backend_to_db ;;
  restrict-frontend-egress) scenario_restrict_frontend_egress ;;
  allow-egress-internet)    scenario_allow_egress_internet ;;
  isolate-database-allow-backend) scenario_isolate_database_allow_backend ;;
  isolate-database)         scenario_isolate_database ;;
  isolate-database-intra)   scenario_isolate_database_intra ;;
  allow-ns-monitoring)           scenario_allow_ns_monitoring ;;
  restrict-db-egress-allow-backend) scenario_restrict_db_egress_allow_backend ;;
  isolate-db-egress-allow-backend)  scenario_isolate_db_egress_allow_backend ;;
  restrict-multiple)             scenario_restrict_multiple ;;
  protocol-tcp-explicit)         scenario_protocol_tcp_explicit ;;
  protocol-udp-blocks-tcp)       scenario_protocol_udp_blocks_tcp ;;
  protocol-multiport)            scenario_protocol_multiport ;;
  scan|*)                        scenario_scan ;;
esac

exit $((FAIL > 0 ? 1 : 0))
