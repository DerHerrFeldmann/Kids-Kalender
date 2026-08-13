// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8934",
  },
  webServer: {
    command: "python3 -m http.server 8934",
    url: "http://localhost:8934/index.html",
    reuseExistingServer: true,
  },
});
