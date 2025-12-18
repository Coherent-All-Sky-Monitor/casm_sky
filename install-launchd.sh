#!/bin/bash

# Automatic launchd service installer for CASM Sky (macOS)
# Detects current user and working directory automatically

set -e

# Detect current information
CURRENT_USER=$(whoami)
WORKING_DIR=$(pwd)
VENV_PATH="$WORKING_DIR/venv"
PYTHON_BIN="$VENV_PATH/bin/python"
MAIN_PY="$WORKING_DIR/main.py"

# launchd plist location
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/com.casm.sky.plist"

echo "Detected configuration:"
echo "  User: $CURRENT_USER"
echo "  Working Directory: $WORKING_DIR"
echo "  Python: $PYTHON_BIN"
echo "  Plist location: $PLIST_FILE"
echo ""

# Check if main.py exists
if [ ! -f "$MAIN_PY" ]; then
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

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$PLIST_DIR"

# Generate plist file
cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.casm.sky</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$MAIN_PY</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$WORKING_DIR</string>
    
    <!-- Start on login/boot -->
    <key>RunAtLoad</key>
    <true/>
    
    <!-- Keep alive with safety limits -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    
    <!-- Throttle restarts to prevent crash loops -->
    <key>ThrottleInterval</key>
    <integer>30</integer>
    
    <!-- Nice value (lower priority) -->
    <key>Nice</key>
    <integer>10</integer>
    
    <!-- Logging -->
    <key>StandardOutPath</key>
    <string>/tmp/casm-sky.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/casm-sky-error.log</string>
    
    <!-- Resource limits -->
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>4096</integer>
    </dict>
</dict>
</plist>
EOF

echo "✓ Generated $PLIST_FILE"
echo ""

# Ask if user wants to load it
read -p "Do you want to load this service now? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Unload first if it exists
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    
    # Load the service
    launchctl load "$PLIST_FILE"
    
    echo ""
    echo "✓ Service loaded!"
    echo ""
    echo "Useful commands:"
    echo "  launchctl start com.casm.sky      - Start the service"
    echo "  launchctl stop com.casm.sky       - Stop the service"
    echo "  launchctl list | grep casm        - Check if service is running"
    echo "  tail -f /tmp/casm-sky.log         - View output logs"
    echo "  tail -f /tmp/casm-sky-error.log   - View error logs"
    echo ""
    echo "To uninstall:"
    echo "  launchctl unload $PLIST_FILE"
    echo "  rm $PLIST_FILE"
    echo ""
    
    read -p "Start the service now? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        launchctl start com.casm.sky
        sleep 2
        echo ""
        echo "Service status:"
        launchctl list | grep casm || echo "Service not found in process list (may have failed to start)"
        echo ""
        echo "Check logs at:"
        echo "  /tmp/casm-sky.log"
        echo "  /tmp/casm-sky-error.log"
    fi
else
    echo "Service file generated but not loaded."
    echo "You can load it later with:"
    echo "  launchctl load $PLIST_FILE"
fi
