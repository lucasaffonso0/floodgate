#!/usr/bin/env bash
# Floodgate — Full API Test Suite
# Cria policies via API, testa conectividade e remove. Roda todos os cenários em sequência.
# Uso: ./full-test.sh [url] [usuario] [senha]
#
# Topology (traffic-sim.yaml):
#   frontend/app       port 80
#   backend/worker     port 8080
#   infra/haproxy      port 80
#   database/pgbouncer port 6432
#   monitoring/grafana port 3000

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
FG_USER="${2:-admin}"
FG_PASS="${3:-admin}"
COOKIE="$(mktemp)"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PROPAGATION_WAIT=3   # segundos para Cilium propagar a NetworkPolicy

trap 'rm -f "$COOKIE"' EXIT

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

TOTAL_PASS=0; TOTAL_FAIL=0; TOTAL_SKIP=0
FAILED_SCENARIOS=()

# ── API helpers ───────────────────────────────────────────────────────────────

login() {
  local tmpfile; tmpfile=$(mktemp)
  local status
  status=$(curl -s -X POST "$BASE_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$FG_USER\",\"password\":\"$FG_PASS\"}" \
    -c "$COOKIE" -o "$tmpfile" -w "%{http_code}")
  rm -f "$tmpfile"
  if [ "$status" != "200" ]; then
    echo -e "${RED}Login falhou (HTTP $status). Verifique URL e credenciais.${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ Autenticado como $FG_USER em $BASE_URL${NC}"
}

# Retorna "<status>|<body>"
api() {
  local method=$1 path=$2 body="${3:-}"
  local tmpfile; tmpfile=$(mktemp)
  local status
  if [ -n "$body" ]; then
    status=$(curl -s -X "$method" "$BASE_URL$path" \
      -b "$COOKIE" -H "Content-Type: application/json" -d "$body" \
      -o "$tmpfile" -w "%{http_code}")
  else
    status=$(curl -s -X "$method" "$BASE_URL$path" \
      -b "$COOKIE" \
      -o "$tmpfile" -w "%{http_code}")
  fi
  echo "${status}|$(cat "$tmpfile")"
  rm -f "$tmpfile"
}

# Verifica campo extraído de JSON e acumula PASS/FAIL
assert_field() {
  local label=$1 actual=$2 expected=$3
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${GREEN}✓${NC} $label = $actual"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $label: esperado '$expected', recebido '$actual'"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return 1
  fi
}

# Extrai campo com python3 de um JSON body (response body sem status prefix)
json_get() {
  local body=$1 expr=$2
  echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); print($expr)" 2>/dev/null || echo ""
}

# Verifica resposta 2xx e imprime resultado
assert_ok() {
  local label=$1 response=$2
  local status body
  status="${response%%|*}"
  body="${response#*|}"
  if [[ "$status" =~ ^2 ]]; then
    echo -e "  ${GREEN}✓${NC} $label"
    return 0
  else
    echo -e "  ${RED}✗${NC} $label (HTTP $status): $(echo "$body" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("detail","?"))' 2>/dev/null || echo "$body")"
    return 1
  fi
}

# Remove todas as policies gerenciadas pelo Floodgate
cleanup() {
  echo -e "\n${YELLOW}  → Limpando policies...${NC}"
  local policies
  policies=$(curl -s "$BASE_URL/api/networkpolicies" -b "$COOKIE")
  local count=0
  while IFS='|' read -r ns name; do
    [ -z "$name" ] && continue
    api DELETE "/api/networkpolicies/$ns/$name" > /dev/null
    count=$((count + 1))
  done < <(echo "$policies" | python3 -c "
import sys, json
for p in json.load(sys.stdin):
    if p.get('managed'):
        print(p['namespace'] + '|' + p['name'])
" 2>/dev/null)
  sleep "$PROPAGATION_WAIT"
  [ "$count" -gt 0 ] && echo -e "  ${GREEN}✓ $count policies removidas${NC}" || echo -e "  ${GREEN}✓ Nenhuma policy para remover${NC}"
}

# Roda run-tests.sh, acumula PASS/FAIL/SKIP e retorna exit code
run_tests() {
  local scenario=$1
  local output rc=0
  output=$(bash "$SCRIPTS_DIR/run-tests.sh" "$scenario" 2>&1) || rc=$?

  # Exibe output sem a linha de "aguardando pods" para não repetir
  echo "$output" | grep -v 'Aguardando\|condition met'

  local pass fail skip
  pass=$(echo "$output" | grep -c '✓ PASS' 2>/dev/null || true)
  fail=$(echo "$output" | grep -c '✗ FAIL' 2>/dev/null || true)
  skip=$(echo "$output" | grep -c 'SKIP'   2>/dev/null || true)

  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  TOTAL_SKIP=$((TOTAL_SKIP + skip))
  return $rc
}

# Cabeçalho de cenário
header_scenario() {
  echo ""
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${BLUE}  $1${NC}"
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════${NC}"
}

# ── Cenários ──────────────────────────────────────────────────────────────────

test_baseline() {
  header_scenario "1/12 — Baseline: sem policies"
  run_tests baseline || FAILED_SCENARIOS+=("baseline")
}

test_restrict_db_ingress() {
  header_scenario "2/12 — restrict-ingress em database/pgbouncer"
  echo "  Aplicando via API:"
  assert_ok "restrict-ingress pgbouncer" "$(api POST '/api/networkpolicies/restrict' \
    '{"service_name":"pgbouncer","namespace":"database","direction":"ingress"}')"
  sleep "$PROPAGATION_WAIT"
  run_tests restrict-db-ingress || FAILED_SCENARIOS+=("restrict-db-ingress")
  cleanup
}

test_allow_backend_to_db() {
  header_scenario "3/12 — restrict-ingress pgbouncer + allow ingress worker → pgbouncer"
  echo "  Aplicando via API:"
  assert_ok "restrict-ingress pgbouncer" "$(api POST '/api/networkpolicies/restrict' \
    '{"service_name":"pgbouncer","namespace":"database","direction":"ingress"}')"
  assert_ok "allow ingress worker→pgbouncer" "$(api POST '/api/networkpolicies' \
    '{"src_workload":"worker","src_namespace":"backend","dst_service":"pgbouncer","dst_namespace":"database","dst_port":6432}')"
  sleep "$PROPAGATION_WAIT"
  run_tests allow-backend-to-db || FAILED_SCENARIOS+=("allow-backend-to-db")
  cleanup
}

test_restrict_frontend_egress() {
  header_scenario "4/12 — restrict-egress em frontend/app"
  echo "  Aplicando via API:"
  assert_ok "restrict-egress app" "$(api POST '/api/networkpolicies/restrict' \
    '{"service_name":"app","namespace":"frontend","direction":"egress"}')"
  sleep "$PROPAGATION_WAIT"
  run_tests restrict-frontend-egress || FAILED_SCENARIOS+=("restrict-frontend-egress")
  cleanup
}

test_allow_egress_internet() {
  header_scenario "5/12 — isolamento egress no frontend + internet liberado (80/443)"
  echo "  Aplicando via API:"
  assert_ok "namespace-isolate frontend (egress+internet)" "$(api POST '/api/networkpolicies/namespace-isolate' \
    '{"namespace":"frontend","direction":"egress","allow_intra_namespace":false,"allow_egress_internet":true}')"
  sleep "$PROPAGATION_WAIT"
  run_tests allow-egress-internet || FAILED_SCENARIOS+=("allow-egress-internet")
  cleanup
}

test_isolate_database_allow_backend() {
  header_scenario "6/12 — namespace-isolate database (ingress) + allow backend/worker → database/pgbouncer"
  echo "  Aplicando via API:"
  assert_ok "namespace-isolate database (ingress)" "$(api POST '/api/networkpolicies/namespace-isolate' \
    '{"namespace":"database","direction":"ingress","allow_intra_namespace":false,"allow_egress_internet":false}')"
  assert_ok "allow ingress worker→pgbouncer" "$(api POST '/api/networkpolicies' \
    '{"src_workload":"worker","src_namespace":"backend","dst_service":"pgbouncer","dst_namespace":"database","dst_port":6432}')"
  sleep "$PROPAGATION_WAIT"
  run_tests isolate-database-allow-backend || FAILED_SCENARIOS+=("isolate-database-allow-backend")
  cleanup
}

test_isolate_database() {
  header_scenario "7/12 — isolamento total do namespace database"
  echo "  Aplicando via API:"
  assert_ok "namespace-isolate database (ambos, sem intra)" "$(api POST '/api/networkpolicies/namespace-isolate' \
    '{"namespace":"database","direction":"both","allow_intra_namespace":false,"allow_egress_internet":false}')"
  sleep "$PROPAGATION_WAIT"
  run_tests isolate-database || FAILED_SCENARIOS+=("isolate-database")
  cleanup
}

test_isolate_database_intra() {
  header_scenario "8/12 — isolamento database com tráfego interno liberado"
  echo "  Aplicando via API:"
  assert_ok "namespace-isolate database (com intra-namespace)" "$(api POST '/api/networkpolicies/namespace-isolate' \
    '{"namespace":"database","direction":"both","allow_intra_namespace":true,"allow_egress_internet":false}')"
  sleep "$PROPAGATION_WAIT"
  run_tests isolate-database-intra || FAILED_SCENARIOS+=("isolate-database-intra")
  cleanup
}

test_allow_ns_monitoring() {
  header_scenario "9/12 — restrict-ingress worker + allow namespace monitoring → backend"
  echo "  Aplicando via API:"
  assert_ok "restrict-ingress worker" "$(api POST '/api/networkpolicies/restrict' \
    '{"service_name":"worker","namespace":"backend","direction":"ingress"}')"
  assert_ok "allow namespace monitoring→backend" "$(api POST '/api/networkpolicies/namespace-ingress' \
    '{"src_namespace":"monitoring","dst_service":"worker","dst_namespace":"backend","dst_port":8080}')"
  sleep "$PROPAGATION_WAIT"
  run_tests allow-ns-monitoring || FAILED_SCENARIOS+=("allow-ns-monitoring")
  cleanup
}

test_restrict_db_egress_allow_backend() {
  header_scenario "10/12 — restrict-egress em database/pgbouncer + allow egress pgbouncer → backend/worker"
  echo "  Aplicando via API:"
  assert_ok "restrict-egress pgbouncer" "$(api POST '/api/networkpolicies/restrict' \
    '{"service_name":"pgbouncer","namespace":"database","direction":"egress"}')"
  assert_ok "allow egress pgbouncer→worker" "$(api POST '/api/networkpolicies/egress' \
    '{"src_workload":"pgbouncer","src_namespace":"database","dst_service":"worker","dst_namespace":"backend","dst_port":8080}')"
  sleep "$PROPAGATION_WAIT"
  run_tests restrict-db-egress-allow-backend || FAILED_SCENARIOS+=("restrict-db-egress-allow-backend")
  cleanup
}

test_isolate_db_egress_allow_backend() {
  header_scenario "11/12 — namespace-isolate database (egress) + allow egress pgbouncer → backend/worker"
  echo "  Aplicando via API:"
  assert_ok "namespace-isolate database (egress)" "$(api POST '/api/networkpolicies/namespace-isolate' \
    '{"namespace":"database","direction":"egress","allow_intra_namespace":false,"allow_egress_internet":false}')"
  assert_ok "allow egress pgbouncer→worker" "$(api POST '/api/networkpolicies/egress' \
    '{"src_workload":"pgbouncer","src_namespace":"database","dst_service":"worker","dst_namespace":"backend","dst_port":8080}')"
  sleep "$PROPAGATION_WAIT"
  run_tests isolate-db-egress-allow-backend || FAILED_SCENARIOS+=("isolate-db-egress-allow-backend")
  cleanup
}

test_restrict_multiple() {
  header_scenario "12/12 — restrict-ingress em database/pgbouncer E backend/worker simultaneamente"
  echo "  Aplicando via API:"
  assert_ok "restrict-ingress pgbouncer" "$(api POST '/api/networkpolicies/restrict' \
    '{"service_name":"pgbouncer","namespace":"database","direction":"ingress"}')"
  assert_ok "restrict-ingress worker" "$(api POST '/api/networkpolicies/restrict' \
    '{"service_name":"worker","namespace":"backend","direction":"ingress"}')"
  sleep "$PROPAGATION_WAIT"
  run_tests restrict-multiple || FAILED_SCENARIOS+=("restrict-multiple")
  cleanup
}

test_protocol_api() {
  header_scenario "13/13 — Protocolos: API cria YAML correto (TCP / UDP / SCTP)"

  # ── TCP explícito ────────────────────────────────────────────────────────────
  echo ""
  echo -e "  ${BOLD}TCP explícito${NC}"
  local r body policy_name policy_ns

  r=$(api POST '/api/networkpolicies/restrict' '{"service_name":"pgbouncer","namespace":"database","direction":"ingress"}')
  assert_ok "restrict-ingress pgbouncer (base)" "$r"

  r=$(api POST '/api/networkpolicies' \
    '{"src_workload":"worker","src_namespace":"backend","dst_service":"pgbouncer","dst_namespace":"database","dst_ports":[{"port":6432,"protocol":"TCP"}]}')
  assert_ok "allow ingress TCP 6432" "$r"
  body="${r#*|}"
  assert_field "dst_ports[0].protocol"  "$(json_get "$body" "d['dst_ports'][0]['protocol']")"  "TCP"
  assert_field "dst_ports[0].port"      "$(json_get "$body" "str(d['dst_ports'][0]['port'])")"  "6432"
  assert_field "dst_ports count"        "$(json_get "$body" "str(len(d['dst_ports']))")"         "1"

  policy_name=$(json_get "$body" "d['name']")
  policy_ns=$(json_get "$body" "d['namespace']")
  if [ -n "$policy_name" ] && [ -n "$policy_ns" ]; then
    local yaml_r yaml_body
    yaml_r=$(api GET "/api/networkpolicies/$policy_ns/$policy_name")
    yaml_body="${yaml_r#*|}"
    local tcp_count
    tcp_count=$(echo "$yaml_body" | grep -c "protocol: TCP" 2>/dev/null || true)
    assert_field "YAML contém 'protocol: TCP'" "$tcp_count" "1"
  fi

  sleep "$PROPAGATION_WAIT"
  run_tests protocol-tcp-explicit || FAILED_SCENARIOS+=("protocol-tcp-explicit")
  cleanup

  # ── UDP ──────────────────────────────────────────────────────────────────────
  echo ""
  echo -e "  ${BOLD}UDP — allow só UDP 5000 não libera TCP${NC}"

  r=$(api POST '/api/networkpolicies/restrict' '{"service_name":"pgbouncer","namespace":"database","direction":"ingress"}')
  assert_ok "restrict-ingress pgbouncer (base)" "$r"

  r=$(api POST '/api/networkpolicies' \
    '{"src_workload":"worker","src_namespace":"backend","dst_service":"pgbouncer","dst_namespace":"database","dst_ports":[{"port":5000,"protocol":"UDP"}]}')
  assert_ok "allow ingress UDP 5000" "$r"
  body="${r#*|}"
  assert_field "dst_ports[0].protocol" "$(json_get "$body" "d['dst_ports'][0]['protocol']")" "UDP"
  assert_field "dst_ports[0].port"     "$(json_get "$body" "str(d['dst_ports'][0]['port'])")" "5000"

  policy_name=$(json_get "$body" "d['name']")
  policy_ns=$(json_get "$body" "d['namespace']")
  if [ -n "$policy_name" ] && [ -n "$policy_ns" ]; then
    yaml_r=$(api GET "/api/networkpolicies/$policy_ns/$policy_name")
    yaml_body="${yaml_r#*|}"
    local udp_count
    udp_count=$(echo "$yaml_body" | grep -c "protocol: UDP" 2>/dev/null || true)
    assert_field "YAML contém 'protocol: UDP'" "$udp_count" "1"
    tcp_count=$(echo "$yaml_body" | grep -c "protocol: TCP" 2>/dev/null || true)
    assert_field "YAML sem 'protocol: TCP' neste allow" "$tcp_count" "0"
  fi

  sleep "$PROPAGATION_WAIT"
  run_tests protocol-udp-blocks-tcp || FAILED_SCENARIOS+=("protocol-udp-blocks-tcp")
  cleanup

  # ── SCTP ─────────────────────────────────────────────────────────────────────
  echo ""
  echo -e "  ${BOLD}SCTP — verifica geração de YAML${NC}"

  r=$(api POST '/api/networkpolicies' \
    '{"src_workload":"worker","src_namespace":"backend","dst_service":"pgbouncer","dst_namespace":"database","dst_ports":[{"port":9000,"protocol":"SCTP"}]}')
  assert_ok "allow ingress SCTP 9000" "$r"
  body="${r#*|}"
  assert_field "dst_ports[0].protocol" "$(json_get "$body" "d['dst_ports'][0]['protocol']")" "SCTP"
  assert_field "dst_ports[0].port"     "$(json_get "$body" "str(d['dst_ports'][0]['port'])")" "9000"

  policy_name=$(json_get "$body" "d['name']")
  policy_ns=$(json_get "$body" "d['namespace']")
  if [ -n "$policy_name" ] && [ -n "$policy_ns" ]; then
    yaml_r=$(api GET "/api/networkpolicies/$policy_ns/$policy_name")
    yaml_body="${yaml_r#*|}"
    local sctp_count
    sctp_count=$(echo "$yaml_body" | grep -c "protocol: SCTP" 2>/dev/null || true)
    assert_field "YAML contém 'protocol: SCTP'" "$sctp_count" "1"
  fi

  cleanup

  # ── Multi-porta TCP + UDP ─────────────────────────────────────────────────────
  echo ""
  echo -e "  ${BOLD}Multi-porta: TCP 6432 + UDP 5000${NC}"

  r=$(api POST '/api/networkpolicies/restrict' '{"service_name":"pgbouncer","namespace":"database","direction":"ingress"}')
  assert_ok "restrict-ingress pgbouncer (base)" "$r"

  r=$(api POST '/api/networkpolicies' \
    '{"src_workload":"worker","src_namespace":"backend","dst_service":"pgbouncer","dst_namespace":"database","dst_ports":[{"port":6432,"protocol":"TCP"},{"port":5000,"protocol":"UDP"}]}')
  assert_ok "allow ingress TCP 6432 + UDP 5000" "$r"
  body="${r#*|}"
  assert_field "dst_ports count"        "$(json_get "$body" "str(len(d['dst_ports']))")" "2"
  assert_field "dst_ports[0].protocol"  "$(json_get "$body" "d['dst_ports'][0]['protocol']")" "TCP"
  assert_field "dst_ports[1].protocol"  "$(json_get "$body" "d['dst_ports'][1]['protocol']")" "UDP"

  policy_name=$(json_get "$body" "d['name']")
  policy_ns=$(json_get "$body" "d['namespace']")
  if [ -n "$policy_name" ] && [ -n "$policy_ns" ]; then
    yaml_r=$(api GET "/api/networkpolicies/$policy_ns/$policy_name")
    yaml_body="${yaml_r#*|}"
    tcp_count=$(echo "$yaml_body" | grep -c "protocol: TCP" 2>/dev/null || true)
    udp_count=$(echo "$yaml_body" | grep -c "protocol: UDP" 2>/dev/null || true)
    assert_field "YAML contém 'protocol: TCP'" "$tcp_count" "1"
    assert_field "YAML contém 'protocol: UDP'" "$udp_count" "1"
  fi

  sleep "$PROPAGATION_WAIT"
  run_tests protocol-multiport || FAILED_SCENARIOS+=("protocol-multiport")
  cleanup

  # ── PATCH preserva protocolo ──────────────────────────────────────────────────
  echo ""
  echo -e "  ${BOLD}PATCH — preserva e atualiza protocolos${NC}"

  r=$(api POST '/api/networkpolicies' \
    '{"src_workload":"worker","src_namespace":"backend","dst_service":"pgbouncer","dst_namespace":"database","dst_ports":[{"port":6432,"protocol":"TCP"}]}')
  assert_ok "create TCP policy para patch" "$r"
  body="${r#*|}"
  policy_name=$(json_get "$body" "d['name']")
  policy_ns=$(json_get "$body" "d['namespace']")

  if [ -n "$policy_name" ] && [ -n "$policy_ns" ]; then
    local patch_r patch_body
    patch_r=$(api PATCH "/api/networkpolicies/$policy_ns/$policy_name" \
      '{"dst_ports":[{"port":6432,"protocol":"TCP"},{"port":5433,"protocol":"TCP"}]}')
    assert_ok "PATCH multi-porta TCP" "$patch_r"
    patch_body="${patch_r#*|}"
    assert_field "PATCH dst_ports count" "$(json_get "$patch_body" "str(len(d['dst_ports']))")" "2"
  fi

  cleanup
}

# ── Main ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║   Floodgate — Full API Test Suite                        ║${NC}"
echo -e "${BOLD}${BLUE}║   $BASE_URL                                   ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

login

echo -e "${YELLOW}Aguardando pods de teste ficarem Ready...${NC}"
kubectl wait --for=condition=Ready pod -l app=app        -n frontend   --timeout=60s 2>/dev/null || true
kubectl wait --for=condition=Ready pod -l app=worker     -n backend    --timeout=60s 2>/dev/null || true
kubectl wait --for=condition=Ready pod -l app=haproxy    -n infra      --timeout=60s 2>/dev/null || true
kubectl wait --for=condition=Ready pod -l app=pgbouncer  -n database   --timeout=60s 2>/dev/null || true
kubectl wait --for=condition=Ready pod -l app=grafana    -n monitoring --timeout=60s 2>/dev/null || true
echo ""

# Garante ambiente limpo antes de começar
cleanup

# Roda todos os cenários em sequência
test_baseline
test_restrict_db_ingress
test_allow_backend_to_db
test_restrict_frontend_egress
test_allow_egress_internet
test_isolate_database_allow_backend
test_isolate_database
test_isolate_database_intra
test_allow_ns_monitoring
test_restrict_db_egress_allow_backend
test_isolate_db_egress_allow_backend
test_restrict_multiple
test_protocol_api

# Limpeza final
cleanup

# ── Resumo ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║   RESUMO FINAL                                           ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "  Checks:  ${GREEN}$TOTAL_PASS passaram${NC} / ${RED}$TOTAL_FAIL falharam${NC} / ${YELLOW}$TOTAL_SKIP pulados${NC}"
echo ""

if [ ${#FAILED_SCENARIOS[@]} -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}✓ TODOS OS CENÁRIOS PASSARAM${NC}"
else
  echo -e "  ${RED}${BOLD}✗ CENÁRIOS COM FALHA:${NC}"
  for s in "${FAILED_SCENARIOS[@]}"; do
    echo -e "    ${RED}•${NC} $s"
  done
fi

echo ""
exit $((${#FAILED_SCENARIOS[@]} > 0 ? 1 : 0))
