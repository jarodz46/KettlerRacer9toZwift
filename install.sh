#!/bin/bash

echo "🚴 Setting up Kettler Zwift Bridge..."

# 1. Install System Dependencies (Required for Bluetooth & Serial)
echo "Installing system libraries..."
sudo apt-get update
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev

# 2. Install Node.js Dependencies
echo "Installing Node.js packages..."
npm install

# 3. Setup Systemd Service (Auto-start)
echo "Configuring auto-start service..."

# Update the working directory in the service file to the current location
CURRENT_DIR=$(pwd)
sed -i "s|WorkingDirectory=.*|WorkingDirectory=${CURRENT_DIR}|" kettler-bridge.service
sed -i "s|ExecStart=.*|ExecStart=$(which node) ${CURRENT_DIR}/index.js|" kettler-bridge.service

# Copy to system folder
sudo cp kettler-bridge.service /etc/systemd/system/

# 4. Enable Service
sudo systemctl daemon-reload
sudo systemctl enable kettler-bridge
sudo systemctl start kettler-bridge

echo "✅ Installation Complete!"
echo "Check status with: sudo systemctl status kettler-bridge"
