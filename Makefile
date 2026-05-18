IMAGE        := floodgate
TAG          ?= latest
KIND_CLUSTER ?= pop-os
NS           := floodgate
HELM_RELEASE := floodgate
HELM_CHART   := ./helm-app-template
HELM_VALUES  := helm-app-template/helmvalues/values.yaml

.PHONY: dev build load deploy port-forward logs

# Hot reload local — sem Docker, sem kind
dev:
	npm run dev

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
