import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// Bed Levelling > Mesh calibration through the console: an unhomed printer is homed first (G28, then
// the printer must report X, Y and Z homed), a homed printer calibrates at once, and failed homing
// never starts the calibration. The bed temperature is chosen, and the result is saved to the mounted
// plate as its measurement at that temperature unless another choice is made.
const root = fileURLToPath(new URL('..', import.meta.url))
process.env.CC2_BACKEND = 'http://127.0.0.1:1'
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), mode: 'demo', server: { port: 0, host: '127.0.0.1' } })
let browser
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '')
  browser = await chromium.launch({ headless: true, ...(process.env.CC2_BROWSER_PATH ? { executablePath: process.env.CC2_BROWSER_PATH, args: ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--single-process', '--no-zygote'] } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], plateCalls = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().includes('/api/plates/')) plateCalls.push([new URL(r.url()).pathname, r.postData()])
  })
  const calibrate = 'BED_MESH_CALIBRATE PROFILE=default BED_TEMP=60'
  // The simulated printer: its homing state, the commands the console accepted and the console state.
  let homed = '', failHoming = false, served = { homed: 0, unhomed: 0 }, meshLoads = 0
  let sent = [], status = { command: '', busy: false, completed: false, success: false, generation: 0, output: '' }
  page.on('request', r => { if (new URL(r.url()).pathname === '/api/mesh') meshLoads++ })
  await page.route('**/api/preferences', r => r.fulfill({ json: { language: 'en', theme: 'dark' } }))
  await page.route('**/api/printer', async route => {
    const response = await route.fetch(), data = await response.json()
    data.motion = { ...data.motion, homed_axes: homed }
    served[homed ? 'homed' : 'unhomed']++
    await route.fulfill({ response, json: data })
  })
  await page.route('**/api/console/command', async route => {
    assert.equal(route.request().headers()['x-cc2-request'], '1', 'console commands carry the mutation marker')
    const command = route.request().postData().trim()
    sent.push(command)
    status = { command, busy: true, completed: false, success: false, generation: status.generation + 1, output: '' }
    await route.fulfill({ status: 202, json: { accepted: true } })
  })
  // A command is reported busy once, then finished; a successful G28 homes the axes.
  await page.route('**/api/console', async route => {
    const reply = { ...status }
    if (status.busy) {
      const ok = !(status.command === 'G28' && failHoming)
      status = { ...status, busy: false, completed: true, success: ok }
      if (status.command === 'G28' && ok) homed = 'xyz'
    }
    await route.fulfill({ json: reply })
  })
  const until = async (test, what) => {
    for (let i = 0; i < 200; i++) {
      if (await test()) return
      await page.waitForTimeout(100)
    }
    assert.fail(what)
  }

  await page.goto(`${origin}/#bed`)
  await page.selectOption('#preview-scene', 'idle')
  // The label wraps its select, so its text includes the options: address the select inside it.
  const side = page.locator('label', { hasText: 'Calibration plate side' }).locator('select')
  const temperature = page.locator('label', { hasText: 'Bed temperature, °C' }).locator('input')
  const target = page.locator('label', { hasText: 'Save the result to plate' }).locator('select')
  await side.waitFor()
  const run = page.getByRole('button', { name: /Run Bed Mesh Calibration/ })
  const dialog = page.getByRole('dialog')
  await side.selectOption('default')
  assert.equal(await target.inputValue(), 'a1b2c3d4e5f60718', 'the mounted Side A plate takes the result')

  // Not homed: the confirmation says so, G28 runs first and the calibration follows once homed.
  await until(() => served.unhomed > 0, 'the page has seen the unhomed printer')
  await run.click()
  await dialog.getByText('The printer is not homed, so it homes X, Y and Z first.', { exact: false }).waitFor()
  await dialog.getByText('Start a new bed mesh calibration at 60 °C?', { exact: false }).waitFor()
  await dialog.getByText('The result becomes the 60 °C measurement of “Smooth PEI”.', { exact: false }).waitFor()
  await dialog.getByText('Nozzle: 0.4 brass', { exact: false }).waitFor()
  const before = meshLoads
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await until(() => sent.length === 2, 'G28 and the calibration were sent')
  assert.deepEqual(sent, ['G28', calibrate])
  await until(() => meshLoads > before, 'the new mesh is loaded after the calibration')
  await until(async () => !(await run.isDisabled()), 'the button is ready again')
  // The side mesh's measurement keeps a printer profile before probing; the result goes to the plate.
  await until(() => plateCalls.length === 2, 'the plate library was told about the calibration')
  assert.deepEqual(plateCalls, [['/api/plates/keep', 'A'], ['/api/plates/measure', 'a1b2c3d4e5f60718\n60\ndd00000000000004']])
  await page.getByText('Saved to “Smooth PEI” as its 60 °C measurement.', { exact: true }).waitFor()

  // Homed: no homing line, the calibration starts at once, at 80 °C and saved to no plate.
  sent = []
  plateCalls.length = 0
  await temperature.fill('120')
  await run.click()
  await page.getByText('Use a whole bed temperature from 40 to 110 °C.', { exact: true }).waitFor()
  assert.equal(await dialog.count(), 0)
  await temperature.fill('80')
  await target.selectOption('')
  const homedSeen = served.homed
  await until(() => served.homed > homedSeen, 'the page has seen the homed printer')
  await page.waitForTimeout(300)
  await run.click()
  await dialog.waitFor()
  assert.equal(await dialog.getByText('The printer is not homed', { exact: false }).count(), 0)
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await until(() => sent.length === 1, 'the calibration was sent')
  assert.deepEqual(sent, ['BED_MESH_CALIBRATE PROFILE=default BED_TEMP=80'])
  await until(async () => !(await run.isDisabled()), 'the button is ready again')
  await page.waitForTimeout(500)
  assert.deepEqual(plateCalls, [['/api/plates/keep', 'A']])

  // Homing fails: an error, and nothing that would probe.
  sent = []
  homed = ''
  failHoming = true
  const unhomedSeen = served.unhomed
  await until(() => served.unhomed > unhomedSeen, 'the page has seen the printer unhomed again')
  await page.waitForTimeout(300)
  await run.click()
  await dialog.getByText('The printer is not homed, so it homes X, Y and Z first.', { exact: false }).waitFor()
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  await page.getByText('Homing did not finish, so the calibration was not started.', { exact: true }).waitFor()
  await page.waitForTimeout(1500)
  assert.deepEqual(sent, ['G28'])
  assert.deepEqual(errors, [])
  console.log('PASS: mesh calibration homes an unhomed printer first, calibrates a homed one at once and stops when homing fails')
} finally { await browser?.close(); await server.close() }
