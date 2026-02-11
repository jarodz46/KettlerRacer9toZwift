const net = require('net');

let clients = [];

const server = net.createServer(socket => {
  console.log("Overlay connecté:", socket.remoteAddress);

  clients.push(socket);

  socket.write(JSON.stringify(lastGear) + "\n");

  socket.on('close', () => {
    clients = clients.filter(c => c !== socket);
    console.log("Overlay déconnecté");
  });

  socket.on('error', () => {
    socket.destroy();
  });
});

server.listen(9999, "0.0.0.0", () => {
  console.log("TCP overlay server listening on port 9999");
});

let lastGear = {gear:"unknown"};

function sendOverlay(data) {
  lastGear = data;
  const msg = JSON.stringify(data) + "\n";

  clients.forEach(c => {
    try {
        console.log("Sending to overlay:", msg.trim());
      c.write(msg);
    } catch (e) {
      console.error("Error sending to overlay:", e);
    }
  });
}

module.exports = { sendOverlay };
