# VPS / 宝塔部署说明

默认部署目录：

```text
/www/wwwroot/aig-workflow-studio
```

## 服务器准备

```bash
cd /www/wwwroot
git clone https://github.com/Magiciangel/aig-workflow-studio.git
cd aig-workflow-studio
npm install
cp .env.example .env
```

编辑 `.env`：

```bash
PORT=4177
HOST=0.0.0.0
VITE_API_BASE=http://112.124.39.6:4177
SEEDANCE_API_KEY=你的 Seedance Key

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=你的 service role key
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=你的 anon key
```

构建前端：

```bash
npm run build
```

Express 会同时提供 API、文件服务和构建后的前端页面。没有配置 Nginx 时，可以先访问：

```text
http://服务器IP:4177
```

## systemd

```bash
sudo cp deploy/aig-workflow-studio.service /etc/systemd/system/aig-workflow-studio.service
sudo systemctl daemon-reload
sudo systemctl enable aig-workflow-studio
sudo systemctl restart aig-workflow-studio
sudo systemctl status aig-workflow-studio --no-pager
```

日志：

```bash
journalctl -u aig-workflow-studio -f
```

## 宝塔 Nginx

在宝塔里创建站点后，把 `deploy/nginx.bt.conf` 的内容合并到站点配置里，并把 `server_name your-domain.com;` 改成你的域名。

如果暂时用 IP 访问，也可以写：

```nginx
server_name 112.124.39.6;
```

## 检查

```bash
curl http://127.0.0.1:4177/api/providers
systemctl status aig-workflow-studio --no-pager
```
