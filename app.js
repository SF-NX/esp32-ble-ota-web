import {
  BLEOTA,
  buildCommand,
  buildSectorPackets,
  parseCommandAck,
  parseOtaPackage,
  parseSectorAck,
  startPayload,
  toBytes
} from './protocol.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REMOTE_MANIFEST = './firmware/manifest.json';

const copy = {
    subtitle: '移动固件更新工具', idle: '等待连接设备', ready: '准备就绪', deviceTitle: '连接设备',
    deviceHint: '选择附近的 BLE OTA 设备', connect: '搜索并连接', disconnect: '断开', firmwareTitle: '选择升级包',
    firmwareHint: '请选择后缀为 .ota 的文件', chooseFile: '选择 .ota 升级包', chooseFileHint: '请上传已下载的仪表OTA文件',
    browse: '浏览', updateTitle: '固件更新', updateHint: '传输时请保持页面在前台', progress: '进度', waiting: '等待开始',
    sent: '已发送', speed: '速度', nextStep: '下一步', connectFirst: '先连接 BLE 设备', chooseFirmware: '请选择固件文件',
    readyToUpdate: '可以开始更新', start: '开始更新', abort: '中止更新', log: '运行日志', logHint: '诊断与传输信息', clear: '清空',
    scanning: '正在搜索设备', chooser: '请在系统窗口中选择 OTA 设备', connecting: '正在连接', discovering: '正在发现 OTA 服务',
    connected: '设备已连接', disconnected: '设备已断开', preparing: '准备安全更新', uploading: '正在传输加密升级包', completed: '更新完成',
    failed: '更新失败', aborted: '更新已中止', secureTitle: '需要安全连接', secureBody: '手机端 Web Bluetooth 必须通过 HTTPS 地址访问。localhost 仅适用于本机预览。',
    iosTitle: '请使用 Bluefy 打开', iosBody: 'iPhone 的 Safari 和 Chrome 不支持 Web Bluetooth。请复制当前 HTTPS 地址并在 Bluefy 中打开。',
    unsupportedTitle: '当前浏览器不支持 Web Bluetooth', unsupportedBody: '请使用 Android Chrome/Edge、桌面 Chrome/Edge，或 iPhone 上的 Bluefy。',
    bluefyTitle: 'Bluefy 兼容模式', bluefyBody: '请允许蓝牙权限，并在 OTA 期间保持 Bluefy 位于前台。',
    secureMode: 'OTA 升级', secureModeHint: '设备端验证升级包完整性', invalidFile: '请选择有效的 .ota 升级包', fileTooLarge: '升级包过大', selectDeviceCancelled: '已取消设备选择',
    secureStartRejected: '设备拒绝启动升级', firmwareIncomplete: '固件未接收完整', lastSectorFallback: '最后一包未收到确认，尝试让设备校验完整固件',
    validating: '发送完成，等待设备校验', restartSuccess: '设备已断开并重启，按升级成功处理', finalAckMissing: '未收到最终确认；若设备已重启则升级完成',
    signatureError: '固件签名校验失败', commandRejected: '设备拒绝了 OTA 命令', sectorFailed: '传输失败',
    completeToast: '固件更新完成，设备即将重启', connectToast: '蓝牙设备连接成功', disconnectToast: '蓝牙连接已断开'
};

const platform = (() => {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const bluefy = /Bluefy/i.test(ua) || Boolean(window.BLENative) || (ios && Boolean(navigator.bluetooth));
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return { ios, bluefy, secure: window.isSecureContext || localhost, bluetooth: Boolean(navigator.bluetooth) };
})();

const state = {
  phase: 'idle', dark: localStorage.getItem('bleota-theme') === 'dark',
  file: null, fileBytes: null, packageInfo: null, uploading: false, abortRequested: false, logs: 0, wakeLock: null
};

class BleAdapter {
  constructor() {
    this.device = null;
    this.server = null;
    this.recvChar = null;
    this.cmdChar = null;
    this.expectedCommand = 0;
    this.expectedSector = 0;
    this.commandWaiter = null;
    this.sectorWaiter = null;
    this.firmwarePayload = 17;
    this.acceptDisconnectAsStopSuccess = false;
    this.stopCompletedByDisconnect = false;
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLEOTA.OTA_SERVICE] }],
      optionalServices: [BLEOTA.DIS_SERVICE]
    });
    this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
    setPhase('connecting', t('connecting'), this.device.name || 'BLE OTA');
    this.server = await this.device.gatt.connect();
    setPhase('preparing', t('discovering'), this.device.name || 'BLE OTA');
    const service = await this.server.getPrimaryService(BLEOTA.OTA_SERVICE);
    this.recvChar = await service.getCharacteristic(BLEOTA.RECV_CHAR);
    this.cmdChar = await service.getCharacteristic(BLEOTA.CMD_CHAR);
    await this.cmdChar.startNotifications();
    await this.recvChar.startNotifications();
    this.cmdChar.addEventListener('characteristicvaluechanged', (event) => this.handleCommandNotification(event));
    this.recvChar.addEventListener('characteristicvaluechanged', (event) => this.handleSectorNotification(event));
    this.firmwarePayload = await this.probeFirmwarePayload();
    return { name: this.device.name || 'Unknown', info: await this.readDeviceInfo(), payload: this.firmwarePayload };
  }

  disconnect(manual = true) {
    if (manual) this.manualDisconnect = true;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.reset();
  }

  async writeCommand(packet, withoutResponse = true) {
    if (!this.cmdChar) throw new Error(t('disconnected'));
    await this.write(this.cmdChar, packet, withoutResponse);
  }

  async writeFirmwarePacket(packet) {
    if (!this.recvChar) throw new Error(t('disconnected'));
    await this.write(this.recvChar, packet, true);
  }

  waitForCommand(command, timeout = BLEOTA.COMMAND_TIMEOUT) {
    this.expectedCommand = command;
    this.commandWaiter = deferred(timeout, `CMD 0x${command.toString(16)} ACK timeout`);
    return this.commandWaiter.promise;
  }

  waitForSector(sector, timeout = BLEOTA.SECTOR_TIMEOUT) {
    this.expectedSector = sector;
    this.sectorWaiter = deferred(timeout, `Sector ${sector} ACK timeout`);
    return this.sectorWaiter.promise;
  }

  async probeFirmwarePayload() {
    const candidates = platform.bluefy ? [247, 185, 122, 64, 20] : [510, 247, 185, 122, 64, 20];
    for (const valueSize of candidates) {
      try {
        await this.write(this.recvChar, new Uint8Array(valueSize), true);
        const payload = Math.max(1, Math.min(BLEOTA.MAX_FIRMWARE_PAYLOAD, valueSize - 3));
        addLog(`BLE value=${valueSize}B, firmware payload=${payload}B`, 'accent');
        return payload;
      } catch (error) {
        addLog(`BLE value ${valueSize}B rejected`, 'info');
      }
    }
    return 17;
  }

  async write(characteristic, bytes, withoutResponse) {
    const value = toBytes(bytes);
    if (withoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') {
      return characteristic.writeValueWithoutResponse(value);
    }
    if (typeof characteristic.writeValue === 'function') return characteristic.writeValue(value);
    if (typeof characteristic.writeValueWithResponse === 'function') return characteristic.writeValueWithResponse(value);
    throw new Error('No compatible BLE write method');
  }

  async readDeviceInfo() {
    const info = { model: '—', firmware: '—', hardware: '—', maker: '—' };
    try {
      const service = await this.server.getPrimaryService(BLEOTA.DIS_SERVICE);
      const fields = [['model', BLEOTA.DIS_MODEL], ['firmware', BLEOTA.DIS_FIRMWARE], ['hardware', BLEOTA.DIS_HARDWARE], ['maker', BLEOTA.DIS_MANUFACTURER]];
      for (const [key, uuid] of fields) {
        try {
          const characteristic = await service.getCharacteristic(uuid);
          const value = await characteristic.readValue();
          info[key] = new TextDecoder().decode(value).replace(/\0/g, '').trim() || '—';
        } catch { /* characteristic is optional */ }
      }
    } catch { addLog('DIS service unavailable', 'info'); }
    return info;
  }

  handleCommandNotification(event) {
    const ack = parseCommandAck(event.target.value, this.expectedCommand);
    if (!ack || !this.commandWaiter) return;
    this.commandWaiter.resolve(ack);
    this.commandWaiter = null;
  }

  handleSectorNotification(event) {
    const ack = parseSectorAck(event.target.value, this.expectedSector);
    if (!ack || !this.sectorWaiter) return;
    this.sectorWaiter.resolve(ack);
    this.sectorWaiter = null;
  }

  handleDisconnect() {
    const manual = this.manualDisconnect;
    const expectedRestart = this.acceptDisconnectAsStopSuccess && this.expectedCommand === BLEOTA.CMD_STOP;
    if (expectedRestart) {
      this.stopCompletedByDisconnect = true;
      this.commandWaiter?.resolve({ command: BLEOTA.CMD_STOP, answer: 0 });
      this.commandWaiter = null;
    }
    this.manualDisconnect = false;
    this.reset();
    onDisconnected(manual, expectedRestart);
  }

  reset() {
    const disconnected = new Error(t('disconnected'));
    this.commandWaiter?.reject(disconnected);
    this.sectorWaiter?.reject(disconnected);
    this.commandWaiter = null;
    this.sectorWaiter = null;
    this.server = null;
    this.recvChar = null;
    this.cmdChar = null;
    this.device = null;
    this.firmwarePayload = 17;
  }

  get connected() { return Boolean(this.device?.gatt?.connected); }
}

const ble = new BleAdapter();

function deferred(timeout, timeoutMessage) {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeout);
  return {
    promise,
    resolve(value) { clearTimeout(timer); resolve(value); },
    reject(error) { clearTimeout(timer); reject(error); }
  };
}

function t(key) { return copy[key] || key; }

function applyTranslations() {
  document.documentElement.lang = 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  refreshAction();
  showPlatformNotice();
}

function setPhase(phase, title = t(phase), detail = '') {
  state.phase = phase;
  $('statusStrip').dataset.state = phase;
  $('statusText').textContent = title;
  $('statusDetail').textContent = detail || t('ready');
}

function showPlatformNotice() {
  const notice = $('platformNotice');
  const link = $('bluefyLink');
  let title = '';
  let body = '';
  link.classList.add('hidden');
  if (!platform.secure) {
    title = t('secureTitle'); body = t('secureBody');
  } else if (platform.ios && !platform.bluefy) {
    title = t('iosTitle'); body = t('iosBody'); link.classList.remove('hidden');
  } else if (!platform.bluetooth) {
    title = t('unsupportedTitle'); body = t('unsupportedBody');
  } else if (platform.bluefy) {
    title = t('bluefyTitle'); body = t('bluefyBody');
  }
  notice.classList.toggle('hidden', !title);
  $('noticeTitle').textContent = title;
  $('noticeBody').textContent = body;
  $('connectButton').disabled = !platform.secure || !platform.bluetooth;
  $('platformBadge').textContent = platform.bluefy ? 'BLUEFY' : platform.ios ? 'iOS' : 'WEB BLE';
}

async function connectDevice() {
  if (!platform.secure || !platform.bluetooth) return showPlatformNotice();
  setPhase('scanning', t('scanning'), t('chooser'));
  addLog(t('scanning'), 'accent');
  try {
    const result = await ble.connect();
    $('deviceName').textContent = result.name;
    $('deviceMeta').textContent = `Connected · payload ${result.payload} B`;
    $('deviceModel').textContent = result.info.model;
    $('deviceFirmware').textContent = result.info.firmware;
    $('deviceHardware').textContent = result.info.hardware;
    $('deviceMaker').textContent = result.info.maker;
    $('devicePanel').classList.remove('hidden');
    $('connectButton').classList.add('hidden');
    $('deviceStep').classList.add('complete');
    setPhase('connected', t('connected'), result.name);
    addLog(`${t('connected')}: ${result.name}`, 'ok');
    toast(`${t('connectToast')}: ${result.name}`, 'success');
    refreshAction();
  } catch (error) {
    const cancelled = error?.name === 'NotFoundError';
    setPhase('idle', t('idle'), cancelled ? t('selectDeviceCancelled') : error.message);
    addLog(cancelled ? t('selectDeviceCancelled') : error.message, cancelled ? 'warn' : 'error');
    if (!cancelled) toast(error.message, 'error');
    ble.disconnect(true);
  }
}

function disconnectDevice() {
  ble.disconnect(true);
}

function onDisconnected(manual, expectedRestart = false) {
  if (state.uploading && !expectedRestart) state.abortRequested = true;
  $('devicePanel').classList.add('hidden');
  $('connectButton').classList.remove('hidden');
  $('deviceStep').classList.remove('complete');
  if (expectedRestart) {
    setPhase('preparing', t('validating'), t('restartSuccess'));
    addLog(t('restartSuccess'), 'ok');
  } else {
    setPhase('idle', t('disconnected'), manual ? t('ready') : t('disconnectToast'));
    addLog(t('disconnected'), 'warn');
    if (!manual) toast(t('disconnectToast'), 'error');
  }
  refreshAction();
}

async function selectFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.ota')) {
    toast(t('invalidFile'), 'error'); return;
  }
  if (file.size > 32 * 1024 * 1024) {
    toast(t('fileTooLarge'), 'error'); return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let packageInfo;
  try {
    packageInfo = parseOtaPackage(bytes);
  } catch (error) {
    addLog(`${t('invalidFile')}: ${error.message}`, 'error');
    toast(error.message, 'error');
    return;
  }
  applyPackageSelection(file, bytes, packageInfo);
}

async function selectRemoteFile() {
  const button = $('remoteFileButton');
  button.disabled = true;
  button.textContent = '下载中...';
  addLog('正在获取在线升级包', 'accent');
  try {
    const manifestResponse = await fetch(`${REMOTE_MANIFEST}?v=${Date.now()}`, { cache: 'no-store' });
    if (!manifestResponse.ok) throw new Error(`升级包信息获取失败 (${manifestResponse.status})`);
    const manifest = await manifestResponse.json();
    const packageResponse = await fetch(`./firmware/${manifest.file}?v=${Date.now()}`, { cache: 'no-store' });
    if (!packageResponse.ok) throw new Error(`升级包下载失败 (${packageResponse.status})`);
    const bytes = new Uint8Array(await packageResponse.arrayBuffer());
    if (bytes.length !== manifest.size) throw new Error('升级包下载不完整');
    if (manifest.sha256 && globalThis.crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const actualHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      if (actualHash !== String(manifest.sha256).toLowerCase()) throw new Error('升级包完整性校验失败');
    }
    const packageInfo = parseOtaPackage(bytes);
    const file = { name: manifest.displayName || manifest.file, size: bytes.length };
    applyPackageSelection(file, bytes, packageInfo);
    addLog(`在线升级包已就绪: ${file.name}`, 'ok');
    toast('升级包已下载并选中', 'success');
  } catch (error) {
    addLog(`在线升级包获取失败: ${error.message}`, 'error');
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '获取';
  }
}

function applyPackageSelection(file, bytes, packageInfo) {
  state.file = file;
  state.fileBytes = bytes;
  state.packageInfo = packageInfo;
  $('fileName').textContent = file.name;
  $('fileSize').textContent = formatBytes(file.size);
  $('filePackageMeta').textContent = `${packageInfo.productId} · ${packageInfo.batchId} · V${packageInfo.firmwareVersion} · S${packageInfo.secureVersion}`;
  $('fileSummary').classList.remove('hidden');
  $('filePicker').classList.add('hidden');
  $('remotePackage').classList.add('hidden');
  $('packageDivider').classList.add('hidden');
  $('fileStep').classList.add('complete');
  addLog(`OTA: ${file.name} (${formatBytes(file.size)}) batch=${packageInfo.batchId}`, 'ok');
  refreshAction();
}

function removeFile() {
  state.file = null; state.fileBytes = null; state.packageInfo = null; $('fileInput').value = '';
  $('filePackageMeta').textContent = '';
  $('fileSummary').classList.add('hidden');
  $('filePicker').classList.remove('hidden');
  $('remotePackage').classList.remove('hidden');
  $('packageDivider').classList.remove('hidden');
  $('fileStep').classList.remove('complete');
  refreshAction();
}

async function startUpdate() {
  if (!ble.connected || !state.fileBytes || state.uploading) return;
  state.uploading = true;
  state.abortRequested = false;
  setPhase('preparing', t('preparing'), state.file.name);
  toggleUploadingUi(true);
  resetProgress();
  await keepScreenAwake(true);
  const startedAt = performance.now();
  const command = BLEOTA.CMD_SECURE;
  try {
    const commandAck = ble.waitForCommand(command);
    await ble.writeCommand(buildCommand(command, startPayload(state.fileBytes.length)));
    addLog(`START SECURE size=${state.fileBytes.length}`, 'accent');
    ensureCommandAccepted(await commandAck, command);
    setPhase('uploading', t('uploading'), state.file.name);
    addLog('OTA accepted, transferring', 'ok');

    let written = 0;
    while (written < state.fileBytes.length && !state.abortRequested) {
      const sectorIndex = Math.floor(written / BLEOTA.SECTOR_SIZE);
      const sector = state.fileBytes.slice(written, written + BLEOTA.SECTOR_SIZE);
      const packets = buildSectorPackets(sector, sectorIndex, ble.firmwarePayload);
      let success = false;
      for (let attempt = 0; attempt < BLEOTA.MAX_RETRIES && !success && !state.abortRequested; attempt += 1) {
        if (attempt > 0) { addLog(`Retry sector ${sectorIndex} (${attempt + 1}/${BLEOTA.MAX_RETRIES})`, 'warn'); await sleep(400); }
        const sectorAck = ble.waitForSector(sectorIndex);
        for (let index = 0; index < packets.length; index += 1) {
          await ble.writeFirmwarePacket(packets[index]);
          if (platform.bluefy) await sleep(4);
          else if (index % 8 === 7) await sleep(0);
        }
        const ack = await sectorAck.catch((error) => ({ answer: -1, error }));
        success = ack.answer === 0;
        if (!success) addLog(formatSectorError(sectorIndex, ack), 'error');
      }
      if (!success) {
        const lastSector = written + sector.length >= state.fileBytes.length;
        if (lastSector) {
          addLog(t('lastSectorFallback'), 'warn');
          written = state.fileBytes.length;
          updateProgress(written, state.fileBytes.length, sectorIndex + 1, startedAt);
          break;
        }
        throw new Error(`${t('sectorFailed')}: Sector ${sectorIndex}`);
      }
      written += sector.length;
      updateProgress(written, state.fileBytes.length, sectorIndex + 1, startedAt);
      addLog(`Sector ${sectorIndex + 1} OK · ${formatBytes(written)}/${formatBytes(state.fileBytes.length)}`, 'ok');
    }

    if (state.abortRequested) {
      await sendStop(false);
      setPhase('aborted', t('aborted'), state.file.name);
      throw new AbortError();
    }

    await sendStopAndWaitForResult();
    updateProgress(state.fileBytes.length, state.fileBytes.length, Math.ceil(state.fileBytes.length / BLEOTA.SECTOR_SIZE), startedAt);
    $('uploadStep').classList.add('complete');
    setPhase('completed', t('completed'), state.file.name);
    $('progressMessage').textContent = t('completeToast');
    addLog(t('completeToast'), 'ok');
    toast(t('completeToast'), 'success');
  } catch (error) {
    if (error instanceof AbortError) {
      addLog(t('aborted'), 'warn'); toast(t('aborted'), 'error');
    } else {
      await sendStop(false).catch(() => {});
      setPhase('failed', t('failed'), error.message);
      $('progressMessage').textContent = error.message;
      addLog(`${t('failed')}: ${error.message}`, 'error');
      toast(`${t('failed')}: ${error.message}`, 'error');
    }
  } finally {
    state.uploading = false;
    state.abortRequested = false;
    toggleUploadingUi(false);
    await keepScreenAwake(false);
    refreshAction();
  }
}

async function sendStop(waitForAck) {
  if (!ble.connected) return;
  if (waitForAck) {
    const ackPromise = ble.waitForCommand(BLEOTA.CMD_STOP);
    await ble.writeCommand(buildCommand(BLEOTA.CMD_STOP), false);
    ensureCommandAccepted(await ackPromise, BLEOTA.CMD_STOP);
  } else {
    await ble.writeCommand(buildCommand(BLEOTA.CMD_STOP));
  }
}

async function sendStopAndWaitForResult() {
  if (!ble.connected) throw new Error(t('disconnected'));
  addLog(t('validating'), 'accent');
  ble.acceptDisconnectAsStopSuccess = true;
  ble.stopCompletedByDisconnect = false;
  try {
    const ackPromise = ble.waitForCommand(BLEOTA.CMD_STOP);
    await ble.writeCommand(buildCommand(BLEOTA.CMD_STOP), false);
    let ack = null;
    try {
      ack = await ackPromise;
    } catch (error) {
      if (!/timeout/i.test(error.message)) throw error;
      addLog(ble.connected ? t('finalAckMissing') : t('restartSuccess'), ble.connected ? 'warn' : 'ok');
      return;
    }
    ensureCommandAccepted(ack, BLEOTA.CMD_STOP);
    addLog(ble.stopCompletedByDisconnect ? t('restartSuccess') : 'Device validation passed', 'ok');
  } finally {
    ble.acceptDisconnectAsStopSuccess = false;
    ble.stopCompletedByDisconnect = false;
  }
}

function ensureCommandAccepted(ack, command) {
  if (ack.answer === 0) return;
  if (ack.answer === 3) throw new Error(t('signatureError'));
  if (command === BLEOTA.CMD_SECURE && ack.answer === 1) throw new Error(t('secureStartRejected'));
  if (command === BLEOTA.CMD_STOP && ack.answer === 1) throw new Error(t('firmwareIncomplete'));
  throw new Error(`${t('commandRejected')}: 0x${ack.answer.toString(16)}`);
}

function formatSectorError(sector, ack) {
  const reasons = { 1: 'CRC error', 2: `Index error (want ${ack.wantedIndex ?? '?'})`, 3: 'Payload length error', 5: 'Cannot start OTA' };
  return `FW NACK sector ${sector}: ${ack.error?.message || reasons[ack.answer] || `0x${Number(ack.answer).toString(16)}`}`;
}

function updateProgress(sent, total, sector, startedAt) {
  const percent = total ? Math.round(sent / total * 100) : 0;
  const seconds = Math.max(.001, (performance.now() - startedAt) / 1000);
  const speed = sent / seconds;
  const eta = speed ? (total - sent) / speed : 0;
  $('progressRing').style.setProperty('--progress', percent);
  $('progressPercent').textContent = `${percent}%`;
  $('progressFill').style.width = `${percent}%`;
  $('progressMessage').textContent = `${formatBytes(sent)} / ${formatBytes(total)}`;
  $('sentStat').textContent = formatBytes(sent);
  $('sectorStat').textContent = sector;
  $('speedStat').textContent = speed ? `${formatBytes(speed)}/s` : '—';
  $('etaStat').textContent = eta > 0 ? formatTime(eta) : '—';
}

function resetProgress() {
  $('uploadStep').classList.remove('complete');
  $('progressRing').style.setProperty('--progress', 0);
  $('progressPercent').textContent = '0%'; $('progressFill').style.width = '0'; $('progressMessage').textContent = t('waiting');
  $('sentStat').textContent = '0 B'; $('sectorStat').textContent = '0'; $('speedStat').textContent = '—'; $('etaStat').textContent = '—';
}

function toggleUploadingUi(uploading) {
  $('startButton').classList.toggle('hidden', uploading);
  $('abortButton').classList.toggle('hidden', !uploading);
  $('connectButton').disabled = uploading;
  $('disconnectButton').disabled = uploading;
  $('fileInput').disabled = uploading;
  $('remoteFileButton').disabled = uploading;
}

function refreshAction() {
  const ready = ble.connected && Boolean(state.fileBytes) && !state.uploading;
  $('startButton').disabled = !ready;
  $('actionHint').textContent = !ble.connected ? t('connectFirst') : !state.fileBytes ? t('chooseFirmware') : t('readyToUpdate');
}

async function keepScreenAwake(enabled) {
  try {
    const bluefyApi = navigator.bluetooth?.setScreenDimEnabled ? navigator.bluetooth : window.bluetooth;
    if (typeof bluefyApi?.setScreenDimEnabled === 'function') bluefyApi.setScreenDimEnabled(!enabled);
    if (enabled && navigator.wakeLock?.request) state.wakeLock = await navigator.wakeLock.request('screen');
    if (!enabled && state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; }
  } catch (error) { addLog(`Wake lock: ${error.message}`, 'info'); }
}

function addLog(message, level = 'info') {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  const line = document.createElement('span');
  line.className = `log-line ${level}`;
  line.textContent = `[${stamp}] ${message}`;
  $('logOutput').append(line, document.createTextNode('\n'));
  $('logOutput').scrollTop = $('logOutput').scrollHeight;
  state.logs += 1;
  $('logCount').textContent = Math.min(state.logs, 99);
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('toastRegion').append(element);
  setTimeout(() => element.remove(), 3800);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

class AbortError extends Error {}

function bindUi() {
  $('connectButton').addEventListener('click', connectDevice);
  $('disconnectButton').addEventListener('click', disconnectDevice);
  $('fileInput').addEventListener('change', (event) => selectFile(event.target.files?.[0]));
  $('remoteFileButton').addEventListener('click', selectRemoteFile);
  $('removeFileButton').addEventListener('click', removeFile);
  $('startButton').addEventListener('click', startUpdate);
  $('abortButton').addEventListener('click', () => { state.abortRequested = true; $('abortButton').disabled = true; addLog(t('aborted'), 'warn'); });
  $('themeButton').addEventListener('click', () => {
    state.dark = !state.dark; localStorage.setItem('bleota-theme', state.dark ? 'dark' : 'light'); applyTheme();
  });
  $('logToggle').addEventListener('click', () => {
    const open = $('logDrawer').classList.toggle('open'); $('logToggle').setAttribute('aria-expanded', String(open));
  });
  $('clearLogButton').addEventListener('click', () => { $('logOutput').textContent = ''; state.logs = 0; $('logCount').textContent = '0'; });
}

function applyTheme() {
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  $('themeButton').querySelector('use').setAttribute('href', state.dark ? '#i-sun' : '#i-moon');
  document.querySelector('meta[name="theme-color"]').content = state.dark ? '#111816' : '#f4f7f6';
}

function init() {
  bindUi(); applyTheme(); applyTranslations(); showPlatformNotice(); resetProgress();
  addLog(`Platform: ${platform.bluefy ? 'Bluefy' : platform.ios ? 'iOS browser' : 'Web Bluetooth'}`, 'accent');
  if ('serviceWorker' in navigator && platform.secure) navigator.serviceWorker.register('./sw.js').catch((error) => addLog(`PWA cache: ${error.message}`, 'info'));
}

init();
