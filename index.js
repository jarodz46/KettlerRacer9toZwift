/*
 * Kettler Racer 9 to Zwift Bridge (Node.js)
 */

const bleno = require('@abandonware/bleno');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// --- CONFIGURATION ---
const SERIAL_PORT = '/dev/ttyUSB0';
const BAUD_RATE = 57600;
const MY_NAME = 'KettlerBike';

// UUIDs (Standard Fitness Machine Service)
const FTMS_SERVICE_UUID = '1826';
const INDOOR_BIKE_DATA_UUID = '2AD2';
const FTMS_CONTROL_POINT_UUID = '2AD9';

// --- BIKE STATE ---
let bikeState = {
  power: 0,
  cadence: 0,
  prevTargetPower: 0,
  targetPower: 0,
  simPower : 0,
  gear: 8,
  mode: 'STD',
  connected: false,
  busy: false // Prevents status loop from interrupting commands
};

const masse = 80;
const gravite = 9.81;
const rho = 1.225;

const gearRatios = [
  1.000, 0.885, 0.783, 0.693,
  0.613, 0.543, 0.481, 0.425,
  0.376, 0.333, 0.295, 0.261,
  0.231, 0.204, 0.180, 0.160
];

// --- EXTERNAL CONDITIONS ---
let externalConditions = {
  windspeed: 0,
  grade: 0,
  crr: 0,
  cw: 0
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
      adjustSimPowerLoop();
      MajAutoGearLoop();
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

  const metrics = data.split('\t');
  //console.log(`[Serial] Received: ${metrics}`);
  // Standard Kettler response parsing
  if (metrics.length >= 8) {
    const rawCadence = parseInt(metrics[1], 10);
    const rawTargetPower = parseInt(metrics[4], 10);
    const rawPower = parseInt(metrics[metrics.length - 1], 10);

    if (!isNaN(rawCadence)) bikeState.cadence = rawCadence;
    if (!isNaN(rawTargetPower)) bikeState.targetPower = rawTargetPower;
    if (!isNaN(rawPower)) bikeState.power = rawPower;

    if (bikeState.mode == 'SIM' && bikeState.targetPower != bikeState.prevTargetPower && bikeState.simPower != bikeState.targetPower) {
      if (bikeState.targetPower > bikeState.prevTargetPower && bikeState.gear < 16) {
        bikeState.gear += 1;
        console.log(`[SIM] Gear Up: ${bikeState.gear}`);
      } else if (bikeState.targetPower < bikeState.prevTargetPower && bikeState.gear > 1) {
        bikeState.gear -= 1;
        console.log(`[SIM] Gear Down: ${bikeState.gear}`);
      }
    }
    bikeState.prevTargetPower = bikeState.targetPower;
    
    if (updateValueCallback) {
      sendBikeData();
    }
  }
  if (metrics.length == 4) {
    const key = parseInt(metrics[3], 10);
    console.log(`[Serial] Button Pressed: ${key}`);
  }
});

function getSimPower() {
  const v = bikeState.cadence * gearRatios[bikeState.gear - 1] * 0.2525;
  const F_g = masse * gravite * externalConditions.grade / 100.0;
  const F_r = masse * gravite * externalConditions.crr;
  const v_rel = v + externalConditions.windspeed;
  const F_d = 0.5 * externalConditions.cw * v_rel * v_rel;
  const totalForce = F_g + F_r + F_d;
  
  let P_sim = Math.max(50, totalForce * v);
  P_sim = Math.min(400, P_sim);
  P_sim = Math.round(P_sim / 5) * 5;

  if (bikeState.simPower != P_sim) {
    bikeState.simPower = P_sim;
    //console.log(`[SIM] Speed: ${v.toFixed(2)} m/s, Cadence: ${bikeState.cadence} rpm, km/h: ${(v*3.6).toFixed(2)}`);
    // console.log(`[SIM] Grade Force: ${F_g.toFixed(2)} N`);
    // console.log(`[SIM] Rolling Resistance Force: ${F_r.toFixed(2)} N`);
    // console.log(`[SIM] Aerodynamic Drag Force: ${F_d.toFixed(2)} N`);
    //console.log(`[SIM] Total Force: ${totalForce.toFixed(2)} N`);
    console.log(`[SIM] Calculated Power: ${bikeState.simPower}W (Gear: ${bikeState.gear})`);
    return true;
  }  
  return false;
}

function MajAutoGearLoop() {
  if (bikeState.mode == 'SIM') {
    if (bikeState.cadence > 10) {
      if (bikeState.cadence > 55 && bikeState.gear > 1) {
        bikeState.gear -= 1;
        console.log(`[SIM] Auto Gear Down: ${bikeState.gear}`);
      }
      else if (bikeState.cadence < 45 && bikeState.gear < 16) {
        bikeState.gear += 1;
        console.log(`[SIM] Auto Gear Up: ${bikeState.gear}`);
      }
    }
  }
  setTimeout(MajAutoGearLoop, 2000);
}

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

function adjustSimPowerLoop() {
  if (bikeState.mode == 'SIM') {
    const update = getSimPower();
    if (update) {
      bikeState.busy = true;
      writeSerial('CM');
      // Wait 150ms for mode switch, then write power
      setTimeout(() => {
        console.log(`[SIM] Adjusting Power: ${bikeState.simPower}W current: ${bikeState.power}W`);
        writeSerial(`PW${bikeState.simPower}`);
        // Wait 150ms for processing, then unlock
        setTimeout(() => { bikeState.busy = false; }, 150);
      }, 150);
    }
  }
  setTimeout(adjustSimPowerLoop, 500);
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

const gearChar = new bleno.Characteristic({
  uuid: '2AD5', // FTMS Gear characteristic
  properties: ['read', 'notify'],
  onReadRequest: (offset, callback) => {
    const buffer = Buffer.alloc(2);
    // Gear: UInt16LE (1-12)
    buffer.writeUInt16LE(bikeState.gear || 1, 0);
    callback(bleno.Characteristic.RESULT_SUCCESS, buffer);
  },
  onSubscribe: (maxValueSize, updateValue) => {
    console.log('[BLE] Gear Subscribed');
    bikeState.gearUpdateCallback = updateValue;
  },
  onUnsubscribe: () => {
    bikeState.gearUpdateCallback = null;
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

      case 0x11:
        try {
          // Ensure we are in SIM mode
          if (bikeState.mode !== 'SIM') bikeState.mode = 'SIM';
          externalConditions.windspeed = data.readInt16LE(1) / 1000.0;
          externalConditions.grade = data.readInt16LE(3) / 100.0;
          externalConditions.crr = data.readUInt8LE(5) / 10000.0;
          externalConditions.cw = data.readUInt8LE(6) / 100.0;
          
          // console.log(`[Zwift] Data: ${JSON.stringify(data)}`);
          // console.log(`[Zwift] SIM: ${JSON.stringify(externalConditions)}`);

          
        } catch (err) {
          console.error('[Zwift] Error parsing simulation params', err);
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
  buffer.writeUInt16LE(bikeState.cadence * 2, 4);
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
        characteristics: [indoorBikeDataChar, gearChar, controlPointChar]
      })
    ]);
  } else {
    console.error(`[System] Advertising error: ${error}`);
  }
});

// Start the engine
openSerial();
