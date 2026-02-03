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
  targetPower: 0,
  gear: 0,
  mode: 'STD',
  connected: false,
  busy: false // Prevents status loop from interrupting commands
};

// --- PHYSICAL MODEL CONFIGURATION ---
const RIDER_MASS = 75; // kg (tunable)
const GRAVITY = 9.80665; // m/s^2
const Crr = 0.004; // rolling resistance coefficient (typical)
const CdA = 0.5; // frontal area * drag coeff (m^2)
const AIR_DENSITY = 1.226; // kg/m^3 at sea level
const WHEEL_CIRCUMFERENCE = 2.1; // estimated meters per crank rev (tunable)

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

      case 0x11: // Set Simulation Parameters (Slope/Wind/Crr/CdA/Gear)
        // Parse simulation parameters from FTMS payload:
        // offset 1: grade (SInt16, hundredths of percent)
        // offset 2: Crr (SInt16, format varies - typically x10000)
        // offset 3: CdA (SInt16, format varies - typically x10000)
        // offset 4+: wind (SInt16), gear, etc.
        try {
          // Ensure we are in SIM mode
          if (bikeState.mode !== 'SIM') bikeState.mode = 'SIM';

          let gradeHundredths = 0;
          let crrRaw = 0;
          let cdaRaw = 0;
          let windHundredths = 0;
          let gear = 1;

          if (data.length >= 3) {
            gradeHundredths = data.readInt16LE(1);
          }
          if (data.length >= 5) {
            crrRaw = data.readInt16LE(2);
          }
          if (data.length >= 7) {
            cdaRaw = data.readInt16LE(3);
          }
          if (data.length >= 9) {
            windHundredths = data.readInt16LE(4);
          }
          if (data.length >= 10) {
            gear = data.readUInt8(8);
            if (gear < 1 || gear > 12) gear = 1; // Sanity check
            bikeState.gear = gear;
          }

          if (gear != 5 && bikeState.gearUpdateCallback) {
              console.log(`[Zwift] Updating Gear to 5 for simulation`);
              const gearBuffer = Buffer.alloc(2);
              gearBuffer.writeUInt16LE(5, 0);
              bikeState.gearUpdateCallback(gearBuffer);
          }

          const grade = gradeHundredths / 100.0; // percent
          const crr = crrRaw / 10000.0; // rolling resistance (typical format)
          const cda = cdaRaw / 10000.0; // drag coefficient*area (typical format)
          const wind = windHundredths / 100.0; // m/s

          const estimatedPower = computePowerFromSimulation({
            gradePercent: grade,
            windMps: wind,
            crr: crr,
            cda: cda,
            gear: gear
          });
          const targetPower = Math.max(0, Math.round(estimatedPower));
          console.log(`[Zwift] SIM: grade=${grade}% wind=${wind}m/s crr=${crr.toFixed(4)} cda=${cda.toFixed(4)} gear=${gear} -> ${targetPower}W`);

          bikeState.targetPower = targetPower;

          // Use Traffic Control to send the power to the trainer
          bikeState.busy = true;
          writeSerial('CM');
          setTimeout(() => {
            writeSerial(`PW${targetPower}`);
            // Also set gear if available in trainer protocol
            if (gear >= 1 && gear <= 12) {
              const gearCode = 100 + gear; // BL<code> format
              writeSerial(`BL${gearCode}`);
            }
            setTimeout(() => { bikeState.busy = false; }, 150);
          }, 150);
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

// Compute an estimated power (watts) from simulation parameters.
// Uses a simple bicycle physics model with an estimated speed derived
// from cadence and a wheel circumference assumption.
// Gear affects wheel speed: higher gear = higher speed multiplier.
function computePowerFromSimulation({ gradePercent = 0, windMps = 0, crr = Crr, cda = CdA, gear = 1 }) {
  // Estimate forward speed from cadence: assume one crank rev -> WHEEL_CIRCUMFERENCE meters
  // Gear acts as a multiplier: gear N means N times the base cadence-to-speed conversion
  const cadenceRps = Math.max(0.1, bikeState.cadence / 60.0); // revs per second
  const baseSpeed = cadenceRps * WHEEL_CIRCUMFERENCE; // m/s
  const speed = baseSpeed * (gear / 8.0); // normalize to mid-gear (8), so gear 8 => 1x multiplier

  // gradePercent is in percent (e.g., 1.5 => 1.5%)
  const grade = gradePercent / 100.0; // unitless

  // gravitational power: m * g * v * sin(theta) ~ m*g*v*grade (small angle)
  const pGrav = RIDER_MASS * GRAVITY * speed * grade;

  // rolling resistance (using passed-in crr parameter)
  const pRoll = RIDER_MASS * GRAVITY * crr * speed;

  // aerodynamic drag: 0.5 * rho * CdA * v_rel^3
  // approximate v_rel = speed - wind (wind positive headwind), so use speed + windMps
  const vRel = Math.max(0, speed + windMps);
  const pAero = 0.5 * AIR_DENSITY * cda * Math.pow(vRel, 3);

  const total = pGrav + pRoll + pAero;
  return total;
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
