# Aria Voss — Website Setup Guide

## What this is

A Node.js/Express web server that:
- Serves the artist website (public)
- Serves a password-protected admin page (`/admin`)
- Accepts MP3 uploads via the admin page and stores them on disk
- Uses server-side sessions (not localStorage) for auth
- Stores passwords as bcrypt hashes — never plain text

---

## 1. Prerequisites

On your Ubuntu LXC, make sure Node.js 18+ is installed:

```bash
node --version
```

If it's missing or below v18:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## 2. Copy the files

Put the project folder on your LXC. If you're copying from another machine:

```bash
scp -r ariavoss/ user@your-lxc-ip:/home/user/ariavoss
```

Or clone/upload however you prefer. The folder structure should be:

```
ariavoss/
├── server.js
├── package.json
├── .env.example
├── public/
│   └── index.html
├── views/
│   └── admin.html
└── uploads/          ← created automatically on first run
```

---

## 3. Install dependencies

```bash
cd ariavoss
npm install
```

---

## 4. Create your .env file

```bash
cp .env.example .env
```

Now edit `.env`:

```bash
nano .env
```

You need to fill in three values:

**SESSION_SECRET** — a long random string, e.g.:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy the output and paste it as the value.

**ADMIN_PASSWORD_HASH** — a bcrypt hash of your chosen password:
```bash
node -e "require('bcryptjs').hash('your-chosen-password', 12).then(console.log)"
```
Copy the hash (it starts with `$2b$12$...`) and paste it as the value.

Your `.env` should look like:
```
PORT=3000
NODE_ENV=production
SESSION_SECRET=a1b2c3d4e5f6...  (your random string)
ADMIN_PASSWORD_HASH=$2b$12$...   (your bcrypt hash)
```

---

## 5. Test it runs

```bash
node server.js
```

You should see:
```
Aria Voss server running on http://127.0.0.1:3000
```

Visit `http://your-lxc-ip:3000` to check it works, then Ctrl+C to stop.

---

## 6. Run it permanently with PM2

PM2 keeps the server running after you close the terminal and restarts it if it crashes.

```bash
sudo npm install -g pm2
pm2 start server.js --name ariavoss
pm2 save
pm2 startup
```

The last command prints a line starting with `sudo env PATH=...` — copy and run that line to make it survive reboots.

Useful PM2 commands:
```bash
pm2 status          # see if it's running
pm2 logs ariavoss   # view live logs
pm2 restart ariavoss
pm2 stop ariavoss
```

---

## 7. Configure nginx on the reverse proxy LXC (192.168.0.252)

Your setup uses a dedicated reverse proxy LXC at `192.168.0.252`, with OPNsense forwarding ports 80 and 443 to it, and Cloudflare in **Full (strict)** mode. The Node server runs on the webserver LXC at `192.168.0.251`.

### SSL certificate

You need a Cloudflare Origin Certificate for the artist's domain. If it's on a **different Cloudflare account** from your EBS domain, you'll need a new one:

1. In Cloudflare → SSL/TLS → Origin Server → Create Certificate
2. Choose "Let Cloudflare generate a key and CSR"
3. Add your domain (e.g. `ariavoss.com` and `*.ariavoss.com`)
4. Select 15-year validity, click Create
5. Copy the certificate and key

On the **reverse proxy LXC** (via the Proxmox web console):

```bash
mkdir -p /etc/ssl/cloudflare/ariavoss
nano /etc/ssl/cloudflare/ariavoss/origin.pem   # paste certificate, Ctrl+X, Y
nano /etc/ssl/cloudflare/ariavoss/origin.key   # paste key, Ctrl+X, Y
chmod 644 /etc/ssl/cloudflare/ariavoss/origin.pem
chmod 600 /etc/ssl/cloudflare/ariavoss/origin.key
```

### nginx site config

On the reverse proxy LXC, create the site config. Replace `yourdomain.com` with the artist's actual domain:

```bash
nano /etc/nginx/sites-available/ariavoss
```

Paste this — it matches the same pattern as your existing EBS config:

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/ssl/cloudflare/ariavoss/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/ariavoss/origin.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy no-referrer-when-downgrade;

    location / {
        proxy_pass         http://192.168.0.251:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;

        # Increase upload limit for MP3s
        client_max_body_size 55M;
    }
}
```

Enable it and reload:

```bash
ln -s /etc/nginx/sites-available/ariavoss /etc/nginx/sites-enabled/
nginx -t               # check for syntax errors — fix anything before continuing
systemctl reload nginx
```

### OPNsense

No changes needed there — it's already forwarding 80 and 443 to `192.168.0.252`. The new domain will just be an additional `server_name` on the same proxy.

### Cloudflare DNS

In Cloudflare for the artist's domain, add an A record pointing to your public IP, with the orange cloud (proxied) enabled. Make sure SSL/TLS mode is set to **Full (strict)**.

---

## 8. Done

- Front page: `https://yourdomain.com`
- Admin page: `https://yourdomain.com/admin`

Log in with the password you chose in step 4. Upload MP3s, set titles, and they appear on the front page immediately.

---

## Changing the admin password later

Log into the admin page, scroll to the bottom, and use the "Change password" form. No server restart needed.

---

## File locations

| What | Where |
|------|-------|
| Uploaded MP3s | `ariavoss/uploads/` |
| Track metadata | `ariavoss/tracks.json` |
| Sessions database | `ariavoss/sessions.db` |
| Environment / password hash | `ariavoss/.env` |

---

## Troubleshooting

**"Cannot find module"** — run `npm install` again.

**Admin login fails immediately** — check that `ADMIN_PASSWORD_HASH` in `.env` is set and starts with `$2b$`.

**Uploads failing at nginx** — make sure `client_max_body_size 55M` is in your nginx config.

**Site not loading after nginx config** — run `sudo nginx -t` and check for errors, then `sudo systemctl reload nginx`.

**Check server logs at any time:**
```bash
pm2 logs ariavoss
```
