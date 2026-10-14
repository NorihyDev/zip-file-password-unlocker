import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
  configure,
} from '@zip.js/zip.js'

configure({ useWebWorkers: false })

async function upload(page: Page, password: string, zipCrypto = false) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false })
  await writer.add('private.md', new TextReader('Recovered content.'), {
    password,
    zipCrypto,
  })
  await writer.add('public.md', new TextReader('Public content.'))
  const blob = await writer.close()
  await page.getByLabel('Choose ZIP file').setInputFiles({
    name: 'fixture.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await blob.arrayBuffer()),
  })
  await expect(page.getByRole('status')).toHaveText('Ready when you are')
}

test('initial interface, guide, accessibility and responsive layout', async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page).toHaveTitle('Unseal — ZIP Password Recovery')
  await expect(
    page.getByRole('button', { name: 'Start recovery', exact: true }),
  ).toBeDisabled()
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-workspace.png`,
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  expect(
    accessibility.violations.map((rule) => ({
      id: rule.id,
      targets: rule.nodes.map((node) => node.target),
    })),
  ).toEqual([])
  await page
    .getByRole('button', { name: 'Open recovery guide', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toBeVisible()
  const guideAccessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  expect(
    guideAccessibility.violations.map((rule) => ({
      id: rule.id,
      targets: rule.nodes.map((node) => node.target),
    })),
  ).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  const dictionary = page.getByRole('radio', { name: /Dictionary/ })
  await dictionary.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: /Brute force/ })).toBeFocused()
  await expect(page.getByLabel('Maximum length')).toBeVisible()
  expect(errors).toEqual([])
})

test('imports a custom dictionary and recovers its exact password', async ({
  page,
}) => {
  await page.goto('/')
  await upload(page, ' personal password ')
  await page.getByLabel('Import wordlist').setInputFiles({
    name: 'custom.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('wrong\r\n personal password \r\nwrong\r\n'),
  })
  await expect(page.getByText('2 candidates', { exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: 'Start recovery', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('Password recovered')
  await expect(page.locator('.result-box code')).toHaveText(
    ' personal password ',
  )
})

test('an unencrypted archive needs no recovery', async ({ page }) => {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false })
  await writer.add('public.md', new TextReader('Already open.'))
  const blob = await writer.close()
  await page.goto('/')
  await page.getByLabel('Choose ZIP file').setInputFiles({
    name: 'open.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await blob.arrayBuffer()),
  })
  await expect(page.getByText('Not encrypted', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Start recovery', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Download original ZIP' }),
  ).toBeVisible()
})

test('sample dictionary recovery stays local and downloads a verified unlocked ZIP', async ({
  page,
}, testInfo) => {
  const remoteRequests: string[] = []
  page.on('request', (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !request.url().startsWith('http://127.0.0.1:4173')
    )
      remoteRequests.push(request.url())
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Try a sample ZIP' }).click()
  await expect(page.getByRole('status')).toHaveText('Ready when you are')
  await page
    .getByRole('button', { name: 'Start recovery', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('Password recovered')
  await expect(page.locator('.result-box code')).toHaveText('hello')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download unlocked ZIP' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('hello-unseal-unlocked.zip')
  const path = await download.path()
  const reader = new ZipReader(
    new BlobReader(new Blob([new Uint8Array(await readFile(path!))])),
  )
  try {
    const entries = await reader.getEntries()
    expect(entries.every((entry) => !entry.encrypted)).toBe(true)
    const entry = entries[0]
    expect(
      !entry.directory && (await entry.getData(new TextWriter())),
    ).toContain('You are in.')
  } finally {
    await reader.close()
  }
  expect(remoteRequests).toEqual([])
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-recovered.png`,
    fullPage: true,
  })
})

test('brute-force recovers a ZipCrypto archive', async ({ page }) => {
  await page.goto('/')
  await upload(page, '07', true)
  await page.getByRole('radio', { name: /Brute force/ }).click()
  await page.getByLabel('Maximum length').fill('2')
  await page
    .getByRole('button', { name: 'Start recovery', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('Password recovered')
  await expect(page.locator('.result-box code')).toHaveText('07')
})

test('hybrid recovery finds a case variation and numeric suffix', async ({
  page,
}) => {
  await page.goto('/')
  await upload(page, 'Zip07')
  await page.getByRole('radio', { name: /Hybrid/ }).click()
  await page.getByLabel('Your wordlist', { exact: true }).fill('zip')
  await page
    .getByRole('button', { name: 'Start recovery', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('Password recovered')
  await expect(page.locator('.result-box code')).toHaveText('Zip07')
})

test('pattern recovery substitutes digit tokens', async ({ page }) => {
  await page.goto('/')
  await upload(page, 'zip07')
  await page.getByRole('radio', { name: /Pattern/ }).click()
  await page.getByLabel('Password pattern').fill('zip?d?d')
  await page
    .getByRole('button', { name: 'Start recovery', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('Password recovered')
  await expect(page.locator('.result-box code')).toHaveText('zip07')
})

test('known password can fail then retry successfully', async ({ page }) => {
  await page.goto('/')
  await upload(page, 'hello')
  await page.getByRole('radio', { name: /Known password/ }).click()
  await page.getByLabel('Archive password', { exact: true }).fill('wrong')
  await page
    .getByRole('button', { name: 'Start recovery', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('Search complete')
  await page.getByLabel('Archive password', { exact: true }).fill('hello')
  await page
    .getByRole('button', { name: 'Start recovery', exact: true })
    .click()
  await expect(page.getByRole('status')).toHaveText('Password recovered')
})

test('cancellation terminates search and configuration enforces limits', async ({
  page,
}) => {
  await page.goto('/')
  await upload(page, 'a-password-not-in-the-search')
  await page.getByRole('radio', { name: /Brute force/ }).click()
  await page.getByLabel('Maximum length').fill('8')
  await expect(page.getByRole('alert')).toContainText('exceeds 5 million')
  await expect(
    page.getByRole('button', { name: 'Start recovery', exact: true }),
  ).toBeDisabled()
  await page.getByLabel('Maximum length').fill('5')
  await page
    .getByRole('button', { name: 'Start recovery', exact: true })
    .click()
  await expect(page.getByLabel('Maximum length')).toBeDisabled()
  await page.getByRole('button', { name: 'Stop recovery' }).click()
  await expect(page.getByRole('status')).toHaveText('Search stopped')
  await expect(page.getByLabel('Maximum length')).toBeEnabled()
  await page.getByRole('button', { name: 'Remove archive' }).click()
  await expect(
    page.getByRole('heading', { name: 'Drop your ZIP file here' }),
  ).toBeVisible()
})

test('rejects invalid uploads with a useful message', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Choose ZIP file').setInputFiles({
    name: 'broken.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('invalid zip'),
  })
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('Needs your attention')
})
