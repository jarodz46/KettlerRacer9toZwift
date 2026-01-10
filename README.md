<!--
 Copyright (c) 2024 Louis Jouret
 
 This software is released under the MIT License.
 https://opensource.org/licenses/MIT
-->

# Kettler Racer 9 to Zwift Bridge (BLE)

This Node.js bridge connects older Kettler Racer 9 bikes to Zwift (or any FTMS-compatible app) via Bluetooth Low Energy.

It solves connection dropouts and command collisions common with Python implementations by using non-blocking I/O.

## Features
* **Solid Stability:** Non-blocking Serial/BLE I/O prevents drops.
* **Traffic Control:** Intelligently queues commands to prevent bike "lockups."
* **Auto-Reconnect:** Automatically recovers if the USB cable is bumped.

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

That's it! The service will start automatically and run on boot.

## Manual Usage
To check logs:
```bash
journalctl -u kettler-bridge -f
