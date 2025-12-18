# Installation Guide

## Quick Install

```bash
make install
```

This will:
- Create a virtual environment in `venv/`
- Install all dependencies from `pyproject.toml`

## Running the Server

### Development Mode (with auto-reload)
```bash
make dev
```

### Production Mode
```bash
make run
```

Or manually:
```bash
source venv/bin/activate
python main.py
```

## System Service Installation

### Linux (systemd)

The installation script automatically detects your username, group, and paths:

```bash
make service
```

This will:
- Auto-detect current user, group, and working directory
- Generate a systemd service file with correct paths
- Prompt to install and enable the service

### Manage the service (Linux)
```bash
# Start the service
sudo systemctl start casm-sky

# Stop the service
sudo systemctl stop casm-sky

# Check status
sudo systemctl status casm-sky

# View live logs
sudo journalctl -u casm-sky -f

# Restart the service
sudo systemctl restart casm-sky
```

### Uninstall the service (Linux)
```bash
make uninstall-service
```

### macOS (launchd)

The installation script automatically detects your username and paths:

```bash
make service-macos
```

This will:
- Auto-detect current user and working directory
- Generate a launchd plist file with correct paths
- Prompt to load and start the service

### Manage the service (macOS)
```bash
# Start the service
launchctl start com.casm.sky

# Stop the service
launchctl stop com.casm.sky

# Check status
launchctl list | grep casm

# View logs
tail -f /tmp/casm-sky.log
tail -f /tmp/casm-sky-error.log
```

### Uninstall the service (macOS)
```bash
make uninstall-service-macos
```

## Cleanup

Remove virtual environment and cache files:
```bash
make clean
```

## Server Configuration

The server listens on `0.0.0.0:9889` by default (configured in `config.yaml`).

Access the web interface at: `http://localhost:9889`
