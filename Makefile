.PHONY: up build dev deploy-testnet deploy-mainnet clean watchdog help

help:
	@echo "Duelist - available targets:"
	@echo "  make up             ONE COMMAND: run the whole stack against live testnet"
	@echo "  make build          Build all contracts and dapp"
	@echo "  make dev            Start dapp dev server only"
	@echo "  make deploy-testnet Deploy your OWN fresh contracts to Stellar testnet"
	@echo "  make deploy-mainnet Deploy to Stellar mainnet"
	@echo "  make clean          Remove build artifacts"

up:
	bash deploy/scripts/up.sh

build:
	bash deploy/scripts/01-build.sh

dev:
	cd dapp && npm run dev

deploy-testnet:
	NETWORK=testnet bash deploy/scripts/deploy.sh --skip-prereqs

deploy-mainnet:
	@echo "=== Deploying to MAINNET ==="
	@read -p "Are you sure? [y/N] " ans && [ "$$ans" = "y" ]
	NETWORK=mainnet bash deploy/scripts/deploy.sh --skip-prereqs

watchdog:
	bash deploy/scripts/watchdog.sh

clean:
	rm -rf contracts/target dapp/dist
