# AIG Workflow Studio

一个本地优先的视频/图片工作流编排工具。前端基于 React + Vite + React Flow，后端基于 Express，当前已接入 Seedance 视频生成接口。

## 功能

- React Flow 节点画布
- Prompt 节点
- Image Input 节点，支持上传图片和 URL
- Video Input 节点，支持上传参考视频和 URL
- Seedance Video 节点
- Image Transform 节点
- 通用 API Request 节点
- Preview 节点，可作为中间结果继续向后连接
- Generated Files 文件列表，方便下载生成文件
- Provider / API Key 配置
- 保存和加载 workflow JSON
- 单密码登录系统，也支持 Supabase Auth
- 按用户隔离生成文件和自定义 Provider
- Server Log 查看和清空

## 技术栈

- React
- Vite
- React Flow
- Express
- 单密码登录 / Supabase Auth
- Seedance API

## 本地开发

```bash
npm install
cp .env.example .env
npm run dev
```

默认地址：

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:4177

如果没有配置登录环境变量，应用会进入 local mode，适合本地单人调试。线上可以优先使用单密码模式。

## 环境变量

```bash
PORT=4177
VITE_API_BASE=http://127.0.0.1:4177
SEEDANCE_API_KEY=replace-with-your-key

# 简单线上登录：设置后，打开网页需要输入这个密码
APP_PASSWORD=replace-with-one-site-password
# 可选。修改后会让旧登录 token 失效。不填时默认用 APP_PASSWORD 签名。
APP_AUTH_SECRET=replace-with-a-long-random-secret

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=replace-with-service-role-key
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=replace-with-anon-key
```

说明：

- `SEEDANCE_API_KEY` 放在后端，只在服务器使用。
- `APP_PASSWORD` 设置后会启用单密码登录，优先级高于 Supabase。
- `APP_AUTH_SECRET` 用来签发登录 token，建议线上设置为一串随机长字符串。
- `SUPABASE_SERVICE_ROLE_KEY` 只能放在后端，不能暴露到前端。
- `VITE_SUPABASE_ANON_KEY` 是前端登录使用的 anon key。

## 单密码登录

适合自己用、朋友小范围共用，配置最少：

```bash
APP_PASSWORD=your-password
APP_AUTH_SECRET=your-long-random-secret
```

配置完成后重启服务。打开网页会先进入密码页，输入正确密码后进入工作台。

单密码模式下所有人共用一个工作区，生成文件保存在 `generated/shared/`。如果需要每个人独立账号和独立数据，请使用 Supabase 登录。

## Supabase 登录

在 Supabase 免费版里创建项目后：

1. 打开 Authentication。
2. 启用 Email 登录。
3. 复制 Project URL、anon key、service role key。
4. 填入 `.env`。
5. 重启 `npm run dev`。

配置完成后，打开前端会先进入登录页。后端会校验 Supabase session token。

## 用户数据隔离

配置 Supabase 后：

- 每个用户只能看到自己的 Generated Files 列表。
- 每个用户的上传和生成文件会保存在 `generated/{userId}/`。
- 每个用户的自定义 Provider 会按 `ownerId` 过滤。

注意：当前 `/files/...` 仍然是静态文件服务，文件名带随机串，列表已按用户隔离。生产级私有文件建议下一步改成 Supabase Storage signed URL 或后端鉴权下载流。

## Seedance 工作流

常见连接方式：

```text
Prompt -> Seedance Video -> Preview
```

图片首帧：

```text
Prompt + Image Input -> Seedance Video -> Preview
```

视频参考：

```text
Prompt + Video Input -> Seedance Video -> Preview
```

多模态参考：

```text
Prompt + Image Input + Video Input -> Seedance Video -> Preview
```

规则：

- 只有 Prompt 时使用 `t2v`。
- Prompt + Image Input 时使用 `i2v_first`。
- Prompt + Video Input 时使用 `multimodal_reference`。
- Prompt + Image Input + Video Input 时，图片作为 `reference_images`，视频作为 `reference_videos`。

## Preview 继续向后连接

Preview 节点可以作为中间结果继续往后传：

```text
Seedance A -> Preview A -> Seedance B -> Preview B
```

workflow 会按连线顺序执行，上游生成的视频或图片会在同一次 Run 里传给下游节点。

## 生成文件

后端会把上传和下载的文件保存到：

```text
generated/
```

右侧 `Generated Files` 会显示：

- 文件名
- 类型
- 大小
- 修改时间
- 下载链接

## VPS 部署思路

部署模板见：

```text
deploy/
```

推荐方式：

1. 在 VPS 上安装 Node.js。
2. 拉取仓库代码。
3. 创建 `.env` 并填入 Seedance 和 Supabase 配置。
4. 执行 `npm install && npm run build`。
5. 用 PM2 或 systemd 启动后端。
6. 用 Nginx 代理前端静态文件和后端 API。

一个常见部署结构：

```text
https://your-domain.com        -> Vite build 后的 dist/
https://your-domain.com/api    -> Express 后端
https://your-domain.com/files  -> Express 文件服务
```

部署到同域名后，建议把 `VITE_API_BASE` 设置成你的后端地址。

## 开源协议

MIT License。
