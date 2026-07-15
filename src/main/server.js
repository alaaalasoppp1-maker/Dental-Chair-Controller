const express = require("express");
const http = require("http");
const os = require("os");
const {WebSocketServer, WebSocket} = require("ws");

class ChairServer {
  constructor({port, onClientsChanged, onNotice}) {
    this.port = port;
    this.onClientsChanged = onClientsChanged || (() => {});
    this.onNotice = onNotice || (() => {});
    this.clients = new Set();
    this.server = null;
    this.wss = null;
    this.heartbeatTimer = null;
  }

  localAddresses() {
    const addresses = [];
    for (const interfaces of Object.values(os.networkInterfaces())) {
      for (const item of interfaces || []) {
        if (item.family === "IPv4" && !item.internal) addresses.push(item.address);
      }
    }
    return addresses;
  }

  primaryAddress() {
    return this.localAddresses()[0] || "127.0.0.1";
  }

  status() {
    return {
      port: this.port,
      clients: this.clients.size,
      address: this.primaryAddress(),
      url: `ws://${this.primaryAddress()}:${this.port}`,
      healthUrl: `http://${this.primaryAddress()}:${this.port}/health`
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      const app = express();
      app.get("/health", (_req, res) => {
        res.json({
          ok: true,
          product: "Dental Chain Chair Controller",
          protocol: 1,
          clients: this.clients.size
        });
      });

      this.server = http.createServer(app);
      this.wss = new WebSocketServer({server: this.server});

      this.wss.on("connection", (socket) => {
        socket.isAlive = true;
        this.clients.add(socket);
        socket.on("pong", () => { socket.isAlive = true; });
        socket.on("close", () => {
          this.clients.delete(socket);
          this.onClientsChanged(this.status());
        });
        socket.on("error", () => {});
        socket.send(JSON.stringify({
          type: "hello",
          protocol: 1,
          controller: "1.0.0",
          sentAt: Date.now()
        }));
        this.onClientsChanged(this.status());
      });

      this.server.once("error", reject);
      this.server.listen(this.port, "0.0.0.0", () => {
        this.onNotice(`خادم الشاشة يعمل على المنفذ ${this.port}`, "success");
        this.onClientsChanged(this.status());
        this.startHeartbeat();
        resolve(this.status());
      });
    });
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          this.clients.delete(socket);
          continue;
        }
        socket.isAlive = false;
        try { socket.ping(); } catch {}
      }
      this.onClientsChanged(this.status());
    }, 15000);
  }

  broadcast(payload) {
    const message = JSON.stringify({...payload, protocol: 1, sentAt: Date.now()});
    let delivered = 0;
    for (const socket of this.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        delivered++;
      }
    }
    return delivered;
  }

  async stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const socket of this.clients) socket.close();
    this.clients.clear();
    if (this.wss) this.wss.close();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}

module.exports = {ChairServer};
