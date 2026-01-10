<!--
 Copyright (c) 2024 Louis Jouret
 
 This software is released under the MIT License.
 https://opensource.org/licenses/MIT
-->

# Kettler Racer 9 to Zwift Bridge (BLE)

This Node.js bridge connects older Kettler Racer 9 bikes to Zwift (or any FTMS-compatible app) via Bluetooth Low Energy. It got developped and tested on a Raspberry Pi 2 W, so that's what I would recommend using. 

## Prerequisites
* Raspberry Pi (Zero W, 3, 4, or 5)
* Kettler Racer 9 connected via USB

## Quick Start

1.  **Clone the repo:**
    ```bash
    git clone git@github.com:LouisJouret/KettlerRacer9toZwift.git
    cd kettler-zwift-bridge
    ```

2.  **Run the installer:**
    ```bash
    chmod +x install.sh
    ./install.sh
    ```

Connect the Kettler Racer 9 to the Raspberry Pi over USB and that's it! The service will start automatically and run on boot. 

## Manual Usage
To check logs:
```bash
journalctl -u kettler-bridge -f
```

## Uninstalling

If you wish to remove the service and stop the bridge from running on boot:

1.  **Stop and disable the background service:**
    ```bash
    sudo systemctl stop kettler-bridge
    sudo systemctl disable kettler-bridge
    ```

2.  **Remove the system configuration:**
    ```bash
    sudo rm /etc/systemd/system/kettler-bridge.service
    sudo systemctl daemon-reload
    ```

3.  **Delete the code (optional):**
    ```bash
    rm -rf kettler-zwift-bridge
    ```
