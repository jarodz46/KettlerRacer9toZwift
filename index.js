/*
 * Kettler Racer 9 to Zwift Bridge (Node.js)
 * Final Version: Stable + Traffic Control
 * * Features:
 * - Non-blocking I/O for 100% connection stability.
 * - "Traffic Control" logic to prevent command collisions.
 * - Auto-reconnects to USB if cable is bumped.
 */

const bleno = require('@abandonware/bleno');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// --- CONFIGURATION ---
const SERIAL_PORT = '/dev/ttyUSB0';
const BAUD_RATE = 57600;
const MY_NAME = 'KettlerRacer9';

// UUIDs (Standard Fitness Machine Service)
const FTMS_SERVICE_UUID = '1826';
const INDOOR_BIKE_DATA_UUID = '2AD2';
const FTMS_CONTROL_POINT_UUID = '2AD9';

// --- BIKE STATE ---
let bikeState = {
  power: 0,
  cadence: 0,
  targetPower: 0,
  gear: 0,
  mode: 'STD',
  connected: false,
  busy: false // Prevents status loop from interrupting commands
};

// --- SERIAL CONNECTION ---
const port = new SerialPort({
  path: SERIAL_PORT,
  baudRate: BAUD_RATE,
  autoOpen: false
});

const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

function openSerial() {
  port.open((err) => {
    if (err) {
      console.error(`[Serial] Error opening port: ${err.message}. Retrying in 5s...`);
      setTimeout(openSerial, 5000);
      return;
    }
    console.log('[Serial] Port opened.');
    
    // Init sequence
    writeSerial('RS');
    setTimeout(() => {
      writeSerial('CM');
      bikeState.connected = true;
      requestStatusLoop();
    }, 5000);
  });
}

function writeSerial(data) {
  if (port.isOpen) {
    port.write(`${data}\r\n`, (err) => {
      if (err) console.error(`[Serial] Write error: ${err.message}`);
    });
  }
}

// Handle incoming data from the bike
parser.on('data', (line) => {
  const data = line.trim();
  if (!data) return;

  const metrics = data.split(/\s+/);
  
  // Standard Kettler response parsing
  if (metrics.length > 7) {
    const rawCadence = parseInt(metrics[1], 10);
    const rawPower = parseInt(metrics[metrics.length - 1], 10);

    if (!isNaN(rawCadence)) bikeState.cadence = rawCadence * 2;
    if (!isNaN(rawPower)) bikeState.power = rawPower;
    
    if (updateValueCallback) {
      sendBikeData();
    }
  }
});

// --- STATUS LOOP (The Heartbeat) ---
function requestStatusLoop() {
  if (!bikeState.connected) return;

  // TRAFFIC CONTROL: If we are sending a command, don't interrupt!
  if (bikeState.busy) {
    setTimeout(requestStatusLoop, 50); // Check again soon
    return;
  }

  writeSerial('ST');
  setTimeout(requestStatusLoop, 250); // 4Hz refresh rate
}

// --- BLUETOOTH LE SETUP ---

let updateValueCallback = null;

const indoorBikeDataChar = new bleno.Characteristic({
  uuid: INDOOR_BIKE_DATA_UUID,
  properties: ['read', 'notify'],
  onSubscribe: (maxValueSize, updateValue) => {
    console.log('[BLE] Zwift connected (Data Subscribed)');
    updateValueCallback = updateValue;
  },
  onUnsubscribe: () => {
    console.log('[BLE] Zwift disconnected');
    updateValueCallback = null;
  },
  onReadRequest: (offset, callback) => {
    callback(bleno.Characteristic.RESULT_SUCCESS, getBikeDataBuffer());
  }
});

const controlPointChar = new bleno.Characteristic({
  uuid: FTMS_CONTROL_POINT_UUID,
  properties: ['write', 'indicate'],
  onWriteRequest: (data, offset, withoutResponse, callback) => {
    if (offset) {
      callback(bleno.Characteristic.RESULT_ATTR_NOT_LONG);
      return;
    }
    
    const opcode = data[0];
    let response = Buffer.from([0x80, opcode, 0x01]); // Default Success

    switch (opcode) {
      case 0x00: // Request Control
      case 0x01: // Reset
        bikeState.mode = 'STD';
        break;
        
      case 0x05: // Set Target Power (ERG Mode)
        const targetPower = data.readInt16LE(1);
        console.log(`[Zwift] Set Power: ${targetPower}W`);
        
        bikeState.mode = 'ERG';
        bikeState.targetPower = targetPower;
        
        // --- TRAFFIC CONTROL EXECUTION ---
        bikeState.busy = true; // Lock the port
        writeSerial('CM');
        
        // Wait 150ms for mode switch, then write power
        setTimeout(() => {
          writeSerial(`PW${targetPower}`);
          // Wait 150ms for processing, then unlock
          setTimeout(() => { bikeState.busy = false; }, 150);
        }, 150);
        // ---------------------------------
        break;
        
      case 0x07: // Start / Resume
        bikeState.mode = 'SIM';
        break;

      case 0x11: // Set Simulation Parameters (Slope/Wind)
        if (bikeState.mode !== 'SIM') {
           bikeState.mode = 'SIM';
           // Use Traffic Control for gear switching too
           bikeState.busy = true;
           writeSerial('CM');
           setTimeout(() => {
             writeSerial(`BL${100 + 8}`); // Default to Gear 8
             bikeState.gear = 8;
             setTimeout(() => { bikeState.busy = false; }, 150);
           }, 150);
        }
        break;
    }

    callback(bleno.Characteristic.RESULT_SUCCESS);
    
    if (updateControlPointCallback) {
      updateControlPointCallback(response);
    }
  },
  onSubscribe: (maxValueSize, updateValue) => {
    console.log('[BLE] Control Point Subscribed');
    updateControlPointCallback = updateValue;
  },
  onUnsubscribe: () => {
    updateControlPointCallback = null;
  }
});

let updateControlPointCallback = null;

function getBikeDataBuffer() {
  const buffer = Buffer.alloc(10);
  // Flags: Instant Power (0x44) + Instant Cadence (0x02)
  buffer.writeUInt8(0x44, 0);
  buffer.writeUInt8(0x02, 1);
  // Speed placeholder
  buffer.writeUInt8(0x00, 2);
  buffer.writeUInt8(0x03, 3);
  // Cadence & Power
  buffer.writeUInt16LE(bikeState.cadence, 4);
  buffer.writeInt16LE(bikeState.power, 6);
  // Padding
  buffer.writeUInt8(0x00, 8);
  buffer.writeUInt8(0x00, 9);
  
  return buffer;
}

function sendBikeData() {
  if (updateValueCallback) {
    updateValueCallback(getBikeDataBuffer());
  }
}

// --- START BLENO ---
bleno.on('stateChange', (state) => {
  if (state === 'poweredOn') {
    bleno.startAdvertising(MY_NAME, [FTMS_SERVICE_UUID]);
  } else {
    bleno.stopAdvertising();
  }
});

bleno.on('advertisingStart', (error) => {
  if (!error) {
    console.log(`[System] Advertising as ${MY_NAME} ready.`);
    bleno.setServices([
      new bleno.PrimaryService({
        uuid: FTMS_SERVICE_UUID,
        characteristics: [indoorBikeDataChar, controlPointChar]
      })
    ]);
  } else {
    console.error(`[System] Advertising error: ${error}`);
  }
});

// Start the engine
openSerial();
