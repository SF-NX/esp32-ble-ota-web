# ESP32 BLE OTA Web

这是一个零后端的静态 PWA，可部署到任意 HTTPS 静态主机。

## 本地预览

在 `web` 目录启动静态服务器：

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

然后在电脑打开 `http://127.0.0.1:4173/`。`localhost` 属于浏览器允许的本地安全上下文，可用于桌面 Chrome/Edge 测试。

## 手机使用

- Android：将整个 `web` 目录部署到 HTTPS 地址，再用 Chrome 或 Edge 打开。
- iPhone/iPad：安装 [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)，在 Bluefy 中打开部署后的 HTTPS 地址。
- iOS Safari/Chrome 不支持 Web Bluetooth，无法直接执行 BLE OTA。

直接通过局域网 `http://电脑IP:4173` 访问不属于安全上下文，手机浏览器不会开放 Web Bluetooth。正式使用请部署到 GitHub Pages、Cloudflare Pages、Netlify 或其他 HTTPS 静态主机。

## 验证协议

```powershell
npm test
```

测试覆盖加密 `.ota` 包头、CRC16、Secure START 命令、sector 分包、末包 CRC 和 ACK 解析。
