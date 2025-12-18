.PHONY: help venv install clean run dev service service-macos uninstall-service uninstall-service-macos

VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
UVICORN := $(VENV)/bin/uvicorn

help:
	@echo "Available targets:"
	@echo "  make venv       - Create virtual environment"
	@echo "  make install    - Create venv and install dependencies"
	@echo "  make run        - Run the server"
	@echo "  make dev        - Run the server with auto-reload"
	@echo "  make clean      - Remove virtual environment"
	@echo "  make service    - Install systemd service (Linux, requires sudo)"
	@echo "  make service-macos - Install launchd service (macOS)"
	@echo "  make uninstall-service - Remove systemd service (Linux)"
	@echo "  make uninstall-service-macos - Remove launchd service (macOS)"

venv:
	python3 -m venv $(VENV)
	@echo "Virtual environment created at $(VENV)"

install: venv
	$(PIP) install --upgrade pip
	$(PIP) install -e .
	@echo ""
	@echo "Installation complete!"
	@echo "To activate the virtual environment, run:"
	@echo "  source $(VENV)/bin/activate"

run:
	$(PYTHON) main.py

dev:
	$(UVICORN) main:app --reload --host 0.0.0.0 --port 9889

clean:
	rm -rf $(VENV)
	rm -rf *.egg-info
	find . -type d -name __pycache__ -exec rm -rf {} +
	@echo "Cleaned up virtual environment and cache files"

service:
	@echo "Installing systemd service (Linux)..."
	@chmod +x install-service.sh
	@./install-service.sh

uninstall-service:
	@echo "Uninstalling systemd service (Linux)..."
	sudo systemctl stop casm-sky.service || true
	sudo systemctl disable casm-sky.service || true
	sudo rm -f /etc/systemd/system/casm-sky.service
	sudo systemctl daemon-reload
	@echo "Service uninstalled"

