#!/bin/bash

# Automatic systemd service installer for CASM Sky
# Detects current user, group, and working directory automatically

set -e

# Detect current information
CURRENT_USER=$(whoami)
CURRENT_GROUP=$(id -gn)
WORKING_DIR=$(pwd)
VENV_PATH="$WORKING_DIR/venv"
PYTHON_BIN="$VENV_PATH/bin/python"

echo "Detected configuration:"
echo "  User: $CURRENT_USER"
echo "  Group: $CURRENT_GROUP"
echo "  Working Directory: $WORKING_DIR"
echo "  Python: $PYTHON_BIN"
echo ""

# Check if main.py exists
if [ ! -f "$WORKING_DIR/main.py" ]; then
    echo "Error: main.py not found in $WORKING_DIR"
    echo "Please run this script from the project directory"
    exit 1
fi

# Check if venv exists, offer to create it
if [ ! -f "$PYTHON_BIN" ]; then
    echo "Virtual environment not found at $VENV_PATH"
    echo ""
    read -p "Do you want to create it and install dependencies now? [Y/n] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        echo "Running: make install"
        make install
        echo ""
        if [ ! -f "$PYTHON_BIN" ]; then
            echo "Error: Installation failed"
            exit 1
        fi
    else
        echo "Cannot proceed without virtual environment"
        exit 1
    fi
fi

# Generate service file
SERVICE_FILE="casm-sky.service"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=CASM Sky Tracking Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_GROUP
WorkingDirectory=$WORKING_DIR
Environment="PATH=$VENV_PATH/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=$PYTHON_BIN main.py

# Restart policy with safety limits
Restart=on-failure
RestartSec=30
StartLimitIntervalSec=300
StartLimitBurst=5

# Security and resource limits
Nice=10
LimitNOFILE=4096
PrivateTmp=true
NoNewPrivileges=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=casm-sky

[Install]
WantedBy=multi-user.target
EOF

echo "Generated $SERVICE_FILE with current system configuration"
echo ""

# Ask if user wants to install it
read -p "Do you want to install this service now? (requires sudo) [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Installing service..."
    sudo cp "$SERVICE_FILE" /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable casm-sky.service
    
    echo ""
    echo "✓ Service installed and enabled!"
    echo ""
    echo "Useful commands:"
    echo "  sudo systemctl start casm-sky    - Start the service"
    echo "  sudo systemctl stop casm-sky     - Stop the service"
    echo "  sudo systemctl status casm-sky   - Check service status"
    echo "  sudo systemctl restart casm-sky  - Restart the service"
    echo "  sudo journalctl -u casm-sky -f   - View live logs"
    echo ""
    read -p "Start the service now? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sudo systemctl start casm-sky
        echo ""
        sudo systemctl status casm-sky
    fi
else
    echo "Service file generated but not installed."
    echo "You can install it later with:"
    echo "  sudo cp $SERVICE_FILE /etc/systemd/system/"
    echo "  sudo systemctl daemon-reload"
    echo "  sudo systemctl enable casm-sky.service"
fi
