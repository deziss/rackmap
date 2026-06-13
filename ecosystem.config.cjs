/** @type {import('pm2').StartOptions[]} */
module.exports = {
  apps: [
    {
      name: "server-inventory-api",
      script: "./apps/api/dist/index.js",
      cwd: ".",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
      env_file: "./apps/api/.env",
      error_file: "./logs/api-error.log",
      out_file: "./logs/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
