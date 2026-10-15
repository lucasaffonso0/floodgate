IMAGE        := floodgate
TAG          ?= latest
KIND_CLUSTER ?= pop-os
NS           := floodgate
HELM_RELEASE := floodgate
HELM_CHART   := ./helm-app-template
HELM_VALUES  := helm-app-template/helmvalues/values.yaml

HUBBLE_LOCAL_PORT ?= 4245

.PHONY: dev dev-hubble build load deploy port-forward logs traffic-sim traffic-sim-stop

# Hot reload local — sem Docker, sem kind
dev:
	npm run dev

# Hot reload local com a Descoberta (Hubble) funcionando. O endereço padrão
# do Relay é um nome DNS interno do cluster, que não resolve fora dele: abre
# um port-forward pro Relay e aponta o app pra ele. Se já houver algo
# escutando na porta (um port-forward aberto antes), reaproveita. O túnel
# aberto aqui é encerrado junto com o dev server.
dev-hubble:
	@if node -e "require('net').connect($(HUBBLE_LOCAL_PORT),'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; then \
		echo "Porta $(HUBBLE_LOCAL_PORT) já em uso: reaproveitando o túnel existente pro Hubble Relay."; \
	else \
		kubectl port-forward -n kube-system svc/hubble-relay $(HUBBLE_LOCAL_PORT):80 >/dev/null & PF=$$!; \
		trap 'kill $$PF 2>/dev/null' EXIT INT TERM; \
		sleep 2; \
		kill -0 $$PF 2>/dev/null || { echo "port-forward pro hubble-relay falhou (cluster ligado? Hubble instalado?)"; exit 1; }; \
	fi; \
	HUBBLE_RELAY_ADDR=localhost:$(HUBBLE_LOCAL_PORT) npm run dev

# Build da imagem Docker
build:
	DOCKER_BUILDKIT=1 docker build -t $(IMAGE):$(TAG) .

# Carrega a imagem no cluster kind
load:
	kind load docker-image $(IMAGE):$(TAG) --name $(KIND_CLUSTER)

# Build + load + helm upgrade --install + rollout restart
# Funciona tanto na primeira vez quanto em deploys subsequentes
deploy: build load
	helm upgrade --install $(HELM_RELEASE) $(HELM_CHART) \
		-f $(HELM_VALUES) \
		-n $(NS) --create-namespace
	kubectl rollout restart deployment/$(HELM_RELEASE) -n $(NS)
	kubectl rollout status deployment/$(HELM_RELEASE) -n $(NS) --timeout=90s

port-forward:
	kubectl port-forward svc/$(HELM_RELEASE) 3000:3000 -n $(NS)

logs:
	kubectl logs -n $(NS) deployment/$(HELM_RELEASE) -f

# Simula tráfego contínuo entre os test-apps para gerar flows no Hubble
traffic-sim:
	kubectl apply -f test-apps/traffic-sim.yaml

traffic-sim-stop:
	kubectl delete -f test-apps/traffic-sim.yaml --ignore-not-found
