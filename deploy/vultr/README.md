# Vultr VM deployment

This is the Forge hackathon backend. Run it on a single Ubuntu Vultr VM with a public DNS name. The Node process listens only on loopback; Caddy terminates HTTPS. Docker runs the disposable Python sandboxes. Use the feature branch until it is merged into the default branch.

1. Install Node 24+, Docker Engine, Caddy, and Git on the VM. Open inbound TCP 80/443 for Caddy; keep 8080 closed. Point the backend DNS name to the VM before starting Caddy.
2. Create the service account and checkout:

   ```sh
   sudo useradd --system --user-group --create-home --shell /usr/sbin/nologin fava
   sudo usermod -aG docker fava
   sudo git clone --depth 1 --branch feat/agent-rush-platform https://github.com/HUSAM-07/vultr-containers.git /opt/fava
   sudo chown -R fava:fava /opt/fava
   sudo docker pull python:3.12-alpine
   sudo -u fava docker run --rm --network none python:3.12-alpine python -c 'print("sandbox ready")'
   ```

3. Create `/etc/fava-forge.env` with permissions `0600`, owned by root. Set `VULTR_INFERENCE_API_KEY`, `VULTR_MODEL`, and a random `WEB_BACKEND_TOKEN` of at least 32 characters. Do not set `INFERENCE_PROVIDER` or `OPENROUTER_API_KEY` for the submission. Do not put these secrets in Git.

   ```sh
   sudo touch /etc/fava-forge.env
   sudo chown root:root /etc/fava-forge.env
   sudo chmod 0600 /etc/fava-forge.env
   sudoedit /etc/fava-forge.env
   ```

4. Install the service and check that the Vultr inference credentials are recognized:

   ```sh
   sudo install -m 0644 /opt/fava/deploy/vultr/fava-forge.service /etc/systemd/system/fava-forge.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now fava-forge
   curl -fsS http://127.0.0.1:8080/health
   ```

   The response should say `"configured":true` and `"provider":"Vultr Serverless Inference"`. The health check does not make a paid inference call. If it fails, inspect `sudo journalctl -u fava-forge -n 100 --no-pager`.

5. Install the Caddy template, replace `api.example.com` with the real DNS name, then validate and reload it. Confirm `https://<backend-domain>/health` returns the same response.

   ```sh
   sudo install -m 0644 /opt/fava/deploy/vultr/Caddyfile /etc/caddy/Caddyfile
   sudoedit /etc/caddy/Caddyfile
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

6. In the Vercel project with root directory `web`, set server-side `VULTR_BACKEND_URL=https://<backend-domain>` and `VULTR_BACKEND_TOKEN` to the same token from step 3. Redeploy the frontend, then run a real build and containment task from `/demo`. Capture both results for the submission video.

The `fava` account has Docker socket access, which is effectively host-level privilege. Give it no SSH login and do not expose the Node port. The service writes run data to `/var/lib/fava-forge/runs.json`; back up that directory before replacing the VM. This JSON store supports one backend process only.
