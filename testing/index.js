/* jshint esversion: 6 */

// ## imports

const homeDir = require('os').homedir();
const fs = require('fs');
const {Builder, By, Key, logging, until} = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const chrome = require('selenium-webdriver/chrome');
const edge = require('selenium-webdriver/edge');
const memoize = require('memoizee');
const fetch = require('node-fetch');
const dateFormat = require('dateformat');
const util = require('util');
const { spawn, exec } = require('child_process');
const execAsync = util.promisify(exec);
const { installDriver: installEdgeDriver } = require('ms-chromium-edge-driver');
const minimist = require('minimist');
const render = require('./render');

const DEFAULT_TIMEOUT_MS = 30000;

require('geckodriver');
require('chromedriver');

// Returns a promise that sleeps for the given millseconds.
let sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ## Selenium setup

// Read a file called .browserstack.json. The file should contain a JSON
// object that looks like:
// `
// {
//   "user": "my_username",
//   "key": "my_api_key"
// }
// `
let browserstackCredentials = memoize(
  () => JSON.parse(fs.readFileSync(homeDir + "/" + ".browserstack.json")),
  { promise: true });

// Returns a browserstack capabilities object. Required
// for producing a browserstack driver.
let fetchBrowserstackCapabilities = async ({user, key}) => {
  let results = (await fetch(`https://${user}:${key}@api.browserstack.com/automate/browsers.json`)).json();
//  console.log(await results);
  return results;
};

// Takes the long capability list from browserstack.com, and
// returns all such browsers that match.
const selectMatchingBrowsers = (allCapabilities, selectionMap) =>
  allCapabilities.filter((capability) => {
    let keep = true;
//    console.log("match", capability, selectionMap);
    for (let prop in selectionMap) {
      if (capability[prop] &&
          selectionMap[prop] &&
          capability[prop].toLowerCase() !== selectionMap[prop].toLowerCase()) {
        keep = false;
      }
//      console.log(prop, capability[prop], selectionMap[prop], keep);
      if (keep === false) break;
    }
    return keep;
  });

// Takes a long capability list from browserstack.com, and
// returns a selection of these. We choose the most recent browsers
// and OS versions.
const selectRecentBrowserstackBrowsers = (allCapabilities) => {
  let OSs = new Set();
  let browsers = new Set();
  // Get names of all operating systems and browsers
  for (let { os, browser } of allCapabilities) {
    OSs.add(os);
    browsers.add(browser);
  }
  let selectedCapabilities = [];
  for (let os of OSs) {
    for (let browser of browsers) {
      let capabilities = allCapabilities
          .filter(c => c.os === os && c.browser === browser)
          .filter(c => c.browser !== "opera" && c.browser !== "ie");
      // Find recent versions of operating system
      let os_versions_set = new Set();
      for (let { os_version } of capabilities) {
        os_versions_set.add(os_version);
      }
      let os_versions = [... os_versions_set];
      let mobile = os === "android" || os === "ios";
      // Use most recent os versions.
      let recent_os_versions = (mobile ? os_versions.sort() : os_versions).slice(-1);
      if (recent_os_versions.length > 0) {
        for (let os_version of recent_os_versions) {
          let capabilities2 = capabilities.filter(c => c.os_version === os_version);
          // Use most recent browser version or representative device
          selectedCapabilities = selectedCapabilities.concat(capabilities2.slice(-1));
        }
      }
    }
  }
//  console.log(selectedCapabilities);
  return selectedCapabilities;
};

// Sets Chrome options for the Builder.
let setChromeOptions = (builder, {incognito, path}) => {
  let options = new chrome.Options();
  if (path) {
    options.setChromeBinaryPath(path);
  }
  options.addArguments("--remote-debugging-port=9222");
  if (incognito) {
    options.addArguments("incognito");
  }
  console.log("setChromeOptions");
  return builder
    .setChromeOptions(options)
    .forBrowser("chrome");
};

// Sets Edge options for the Builder.
let setEdgeOptions = async (builder, {incognito, path}) => {
  let options = new edge.Options();
  if (path) {
    options.setBinaryPath(path);
  }
  const edgePaths = await installEdgeDriver();
  options.setEdgeChromium(true);
  return builder
    .setEdgeOptions(options)
    .setEdgeService(new edge.ServiceBuilder(edgePaths.driverPath))
    .forBrowser("edge");
};

// Set Firefox options for the Builder.
let setFirefoxOptions = (builder, {incognito, path}) => {
  let options = new firefox.Options();
  if (path) {
    options.setBinaryPath(path);
  }
  if (incognito) {
    options.addArguments("-private");
  }
  return builder
    .setFirefoxOptions(options)
    .forBrowser("firefox")
};

let getBestBrowserstackCapabilities =
    async ({ user, key, browser, browser_version, os, os_version }) => {
  let browserstackCapabilities = await fetchBrowserstackCapabilities({user, key});
  let capabilitiesList = selectMatchingBrowsers(
    browserstackCapabilities, { browser, os, browser_version, os_version });
  return capabilitiesList[0];
}

let setToBrowserstack =
    async (builder, { browser, browser_version, os, os_version }) => {
  let { user, key } = await browserstackCredentials();
  builder.usingServer(`http://${user}:${key}@hub-cloud.browserstack.com/wd/hub`);
  let capabilities = await getBestBrowserstackCapabilities(
    { user, key, browser, browser_version, os, os_version });
  builder.withCapabilities(capabilities);
};

// Produces a selenium driver to run tests,
// using the given config object.
let createDriver = async ({browser, browser_version,
                           os, os_version,
                           service, incognito, path}) => {
  let builder = new Builder();
  if (service === "browserstack") {
    await setToBrowserstack(builder, { browser, browser_version, os, os_version });
  }
  if (browser === "chrome" || browser === "chromium") {
    setChromeOptions(builder, { incognito, path });
  } else if (browser === "edge") {
    await setEdgeOptions(builder, { incognito, path });
  } else if (browser === "firefox") {
    setFirefoxOptions(builder, { incognito, path });
  } else {
    throw new Exception("unknown browser");
  }
  return builder.build();
};

// ## Testing

// Tell the selenium driver to look at a particular elements's
// attribute and wait for it to have a value. Returns a promise.
let waitForAttribute = (driver, element, attrName, timeout) =>
    driver.wait(async () => element.getAttribute(attrName), timeout);

let openNewTab = async (driver) => {
  let tabsBefore = await driver.getAllWindowHandles();
  await driver.switchTo().window(tabsBefore[0]);
  await driver.get("https://example.com");
  await driver.executeScript(`
    document.body.addEventListener("click", () => window.open("https://example.com", "_blank"));
  `);
  await driver.findElement(By.tagName('body')).click();
  let tabsAfter = await driver.getAllWindowHandles();
  return tabsAfter.filter(x => !tabsBefore.includes(x))[0];
};

// Tell the selenium driver to visit a url, wait for the attribute
// "data-test-results" to have a value, and resolve that value
// in a promise. Rejects if timeout elapses first.
let loadAndGetResults = async (driver, url, newTab = false, timeout = DEFAULT_TIMEOUT_MS) => {
  if (newTab) {
    let tab = await openNewTab(driver);
    await driver.switchTo().window(tab);
  }
  console.log(`loading ${url}`);
  await driver.get(url);
  let body = await driver.findElement(By.tagName('body'));
  let testResultsString =
      await waitForAttribute(driver, body, "data-test-results", timeout);
  return testResultsString === "undefined" ? undefined : JSON.parse(testResultsString);
};

// Causes driver to connect to our supercookie tests. Returns
// a map of test names to test results.
let runSupercookieTests = async (driver, newTabs) => {
  let stem = newTabs ? "supercookies" : "navigation";
  let secret = Math.random().toString().slice(2);
  let iframe_root_same = false ? "http://localhost:8080" : "https://arthuredelstein.net/browser-privacy";
  let iframe_root_different = false ? "http://localhost:8080" : "https://arthuredelstein.github.io/browser-privacy";
  let writeResults = await loadAndGetResults(
    driver, `${iframe_root_same}/tests/${stem}.html?mode=write&default=${secret}`, true);
//  console.log("writeResults:", writeResults, typeof(writeResults));
  let readParams = "";
  for (let [test, data] of Object.entries(writeResults)) {
    if ((typeof data["result"]) === "string") {
      readParams += `&${test}=${encodeURIComponent(data["result"])}`;
    }
  }
  //  console.log(readParams);
//  await sleep(5000);
  let readResultsSameFirstParty = await loadAndGetResults(
    driver, `${iframe_root_same}/tests/${stem}.html?mode=read${readParams}`, newTabs);
  //  console.log("readResultsSameFirstParty:", readResultsSameFirstParty);
  //await sleep(5000);
  let readResultsDifferentFirstParty = await loadAndGetResults(
    driver, `${iframe_root_different}/tests/${stem}.html?mode=read${readParams}`, newTabs);
  let jointResult = {};
  for (let test in readResultsDifferentFirstParty) {
    let { write, read, result: readDifferentFirstParty } = readResultsDifferentFirstParty[test];
    let { result: readSameFirstParty } = readResultsSameFirstParty[test];
    let testFailed = !readSameFirstParty || readSameFirstParty.startsWith("Error:");
    let passed = testFailed ? undefined : (readSameFirstParty !== readDifferentFirstParty);
    jointResult[test] = { write, read, readSameFirstParty, readDifferentFirstParty, passed, testFailed };
  }
//  console.log("readResultsDifferentFirstParty:", readResultsDifferentFirstParty);
  return jointResult;
};

// Run all of our privacy tests using selenium. Returns
// a map of test types to test result maps. Such as:
// `
// { "fingerprinting" : { "window.screen.width" : { /* results */ }, ... }
//   "tor" : { ... }
//   "supercookies" : { ... } }
let runTests = async function (driver) {
  try {
    let fingerprinting = await loadAndGetResults(
      driver, 'https://arthuredelstein.github.io/browser-privacy/tests/fingerprinting.html');
    let tor = await loadAndGetResults(
      driver, 'https://arthuredelstein.github.io/browser-privacy/tests/tor.html');
    let supercookies = await runSupercookieTests(driver, true);
    let navigation = await runSupercookieTests(driver, false);
    return { fingerprinting, tor,
             supercookies: Object.assign({}, supercookies, navigation)};
  } catch (e) {
    console.log(e);
    return null;
  }
};

// Reads the current git commit hash for this program in a string. Used
// when reporting results, to make them easier to reproduce.
let gitHash = async function () {
  const { stdout, stderr } = await execAsync('git rev-parse HEAD');
  if (stderr) {
    throw new Error(stderr);
  } else {
    return stdout.trim();
  }
};

// Runs a batch of tests (multiple browsers) for a given driver.
// Returns results in a JSON object.
let runTestsBatch = async function (configList, {shouldQuit} = {shouldQuit:true}) {
  let all_tests = [];
  let timeStarted = new Date().toISOString();
  let git = await gitHash();
  for (let config of configList) {
    try {
      let { browser, prefs, incognito } = config;
      console.log("about to create driver:");
      let driver = await createDriver(config);
      console.log("driver", driver);
      let fullCapabilitiesMap = (await driver.getCapabilities())["map_"];
      let fullCapabilities = Object.fromEntries(fullCapabilitiesMap.entries());
      console.log('fullCapabilities', fullCapabilities);
      let timeStarted = new Date().toISOString();
      let testResults = await runTests(driver);
      if (shouldQuit) {
        await driver.quit();
      }
      all_tests.push({ browser, capabilities: fullCapabilities, testResults, timeStarted,
                       prefs, incognito });
    } catch (e) {
      console.log(e);
    }
  }
  let timeStopped = new Date().toISOString();
  return { all_tests, git, timeStarted, timeStopped };
};

// ## Writing results

// Takes our results in a JSON object and writes them to disk.
// The file name looks like `yyyymmdd__HHMMss.json`.
let writeDataSync = function (data) {
  let dateStub = dateFormat(new Date(), "yyyymmdd_HHMMss", true);
  let filePath = `out/results/${dateStub}.json`;
  fs.mkdirSync("out/results", { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  console.log(`Wrote results to "${filePath}".`);
};

let expandConfigList = async (configList) => {
  let results = [];
  for (let config of configList) {
    if (!config.disable) {
      results = [].concat(results, Array(config.repeat).fill(config));
    }
  }
  return results;
}

// The main program
let main = async () => {
  // Read config file and flags from command line
//  logging.installConsoleHandler();
//  logging.getLogger().setLevel(logging.Level.ALL);
//  logging.getLogger("browser").setLevel(logging.Level.ALL);
  let { _ : [configFile], stayOpen, only, list } = minimist(process.argv.slice(2));
  if (list) {
    let capabilityList = await fetchBrowserstackCapabilities();
    for (let capability of capabilityList) {
      console.log(capability);
    }
  } else {
    let configList = JSON.parse(fs.readFileSync(configFile));
    let expandedConfigList = await expandConfigList(configList);
    let filteredExpandedConfigList = expandedConfigList.filter(
      d => only ? d.browser.startsWith(only) : true);
    console.log(filteredExpandedConfigList);
    writeDataSync(await runTestsBatch(filteredExpandedConfigList,
                                      { shouldQuit: !stayOpen }));
    render.main();
  }
}

main();
