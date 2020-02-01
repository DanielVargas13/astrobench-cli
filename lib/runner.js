/* global astrobench */

const connect = require('connect')
const serve = require('serve-static')
const { Instance: Chalk } = require('chalk')

let server
let browser
let page

async function run ({
  browser, directory, port, headless, sandbox, timeout, url, color, verbose
} = {}) {
  try {
    url = await start({
      browser, directory, port, headless, sandbox, url, verbose
    })
    return await test({ timeout, color, verbose })
  } finally {
    await stop({ verbose })
  }
}

async function start ({
  browser, directory, port, headless, sandbox, url, verbose
} = {}) {
  const absoluteUrl = url.includes('://') && url.indexOf('://') < url.indexOf('/')
  if (!absoluteUrl) {
    port = await startServer({ directory, port, verbose })
    url = `http://localhost:${port}/${url}`
  }
  await openBrowser({ browserName: browser, headless, sandbox, url, verbose })
}

function startServer ({ directory, port, verbose } = {}) {
  if (!directory) {
    directory = '.'
  }
  if (!port) {
    port = 0
  }
  if (verbose) {
    console.log(`--- Starting the server at "${directory}" on port ${port}`)
  }
  return new Promise((resolve, reject) => {
    server = connect()
      .use(serve(directory, { etag: false }))
      .listen(port, error => {
        if (error) {
          reject(error)
        } else {
          resolve(server.address().port)
        }
      })
  })
}

async function openBrowser ({ browserName, headless, sandbox, url, verbose } = {}) {
  if (verbose) {
    console.log(`--- Launching the ${browserName} browser`)
  }
  const puppeteer = require(
    browserName === 'chrome' ? 'puppeteer' : 'puppeteer-firefox')
  browser = await puppeteer.launch({
    headless: headless !== false,
    args: sandbox !== 'false' ? [] : ['--no-sandbox']
  })
  page = await browser.newPage()
  if (verbose) {
    relayConsole(verbose)
    console.log(`--- Navigating to ${url}`)
  }
  await page.goto(url)
}

function relayConsole ({ network, browserConsole } = {}) {
  const prefixes = {
    log: 'LOG',
    debug: 'DBG',
    info: 'INF',
    error: 'ERR',
    warning: 'WRN',
    dir: 'DIR',
    dirxml: 'DIX',
    table: 'TBL',
    trace: 'TRC',
    clear: 'CLR',
    startGroup: 'GRP',
    startGroupCollapsed: 'GRP',
    endGroup: 'GRE',
    assert: 'ASR',
    profile: 'PRF',
    profileEnd: 'PRE',
    count: 'CNT',
    timeEnd: 'TIM'
  }
  if (browserConsole !== false) {
    page.on('console', message =>
      console.log(`${prefixes[message.type()] || '???'} ${message.text()}`))
  }
  page.on('pageerror', ({ message }) => console.log(message))
  if (network !== false) {
    page
      .on('response', response =>
        console.log(`${response.status()} ${response.url()}`))
      .on('requestfailed', request =>
        console.log(`${request.failure().errorText} ${request.url()}`))
  }
}

async function test ({ timeout, color, verbose } = {}) {
  await runTests({ timeout, verbose })
  await watchProgress({ timeout, color, verbose })
  return computeResults({ verbose })
}

async function runTests ({ timeout, verbose } = {}) {
  if (verbose) {
    console.log(`--- Waiting for the page content to appear (max. ${timeout}s)`)
  }
  timeout = (timeout || 60) * 1000
  // The content of #astrobench is populated when all suites are created.
  await page.waitForSelector('#astrobench .fn-suites', {
    visible: true, timeout
  })
  if (verbose) {
    console.log('--- Running the benchmarks')
  }
  await page.evaluate(
    /* istanbul ignore next */
    () => astrobench())
}

async function watchProgress ({ timeout, color, verbose } = {}) {
  const chalk = new Chalk(color !== false ? undefined : { level: 0 })
  timeout = (timeout || 60) * 1000
  let lastSuite
  let lastBench
  // Loop until all suites have ended. Each iteration means a state change.
  do {
    const { suiteIndex, benchIndex } = await page.evaluate(
      /* istanbul ignore next */
      () => {
        const { index: suiteIndex, benchIndex } = astrobench.state
        return { suiteIndex, benchIndex }
      })
    if (verbose) {
      const { suiteName, benchName } = await page.evaluate(
        /* istanbul ignore next */
        () => {
          const { index: suiteIndex, benchIndex, describes } = astrobench.state
          const suite = describes[suiteIndex].suite
          const suiteName = suite.name
          const benchName = suite[benchIndex].name
          return { suiteName, benchName }
        })
      if (suiteName !== lastSuite) {
        console.log(chalk`--- Suite {yellow ${suiteName}}`)
        lastSuite = suiteName
        lastBench = null
      }
      if (benchName !== lastBench) {
        console.log(chalk`---   Benchmark {cyan ${benchName}}`)
        lastBench = benchName
      }
    }
    // Wait for any state change - switching to another benchmark, starting
    // with another suite or finishing of all suites.
    await page.waitForFunction(
      /* istanbul ignore next */
      (lastSuite, lastBench) => {
        const { index: suiteIndex, benchIndex, running } = astrobench.state
        return !running || suiteIndex !== lastSuite || benchIndex !== lastBench
      },
      { timeout }, suiteIndex, benchIndex)
  } while (await page.evaluate(
    /* istanbul ignore next */
    () => astrobench.state.running))
}

function computeResults ({ verbose } = {}) {
  if (verbose) {
    console.log('--- Computing results')
  }
  return page.evaluate(
    /* istanbul ignore next */
    () => astrobench.state.describes.map(({ suite }) => ({
      name: suite.name,
      benchmarks: suite.map(({ name, error, aborted, hz, stats, sum, times }) => {
        if (error) {
          const { message, name, stack } = error
          error = { message, name, stack }
        }
        return { name, error, aborted, hz, stats, sum, times }
      })
    })))
}

async function stop ({ verbose } = {}) {
  await Promise.all([closeBrowser({ verbose }), stopServer({ verbose })])
}

async function closeBrowser ({ verbose } = {}) {
  if (browser) {
    if (verbose) {
      console.log('--- Closing the browser')
    }
    browser.close()
    browser = null
  }
}

async function stopServer ({ verbose } = {}) {
  if (server) {
    if (verbose) {
      console.log('--- Stopping the server')
    }
    return new Promise(resolve => {
      server.close(resolve)
      server = null
    })
  }
}

process.on('SIGINT', () => {
  console.log()
  stop({ verbose: true })
})

module.exports = run