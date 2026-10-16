module.exports = {
  apps: [
    {
      name: 'ascent',
      script: './server/index.js',
      // The Node that ran `pm2 start` (start.sh selects it) — the one setup.sh installed
      // the server's native modules for.
      interpreter: process.execPath,
      watch: false,
      restart_delay: 2000,
      env: {
        PORT: 3001,
        NODE_ENV: 'production',
        NVM_DIR: process.env.HOME + '/.nvm',
      },
    },
  ],
};
