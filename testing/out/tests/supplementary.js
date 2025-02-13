const fetchJSON = async (...fetchArgs) => {
  let response = await fetch(...fetchArgs);
  return response.json();
};

const testIp = async () => {
  const wtfJSON = await fetchJSON("https://wtfismyip.com/json");
  console.log(wtfJSON);
  const ipAddress = wtfJSON["YourFuckingIPAddress"];
  return {
    "IP address leak" : {
      ipAddress,
      description: "IP addresses can be used to uniquely identify a large percentage of users. A proxy, VPN, or Tor can mask a user's IP address."
    }};
};

const testFontFingerprinting = () => {
  let div1 = document.createElement("div1");
  div1.innerText = "font fingerprinting";
  div1.setAttribute("style", "font-family: Monoton, monospace");
  let div2 = document.createElement("div2");
  div2.innerText = "font fingerprinting";
  div2.setAttribute("style", "font-family: Monoton, sans-serif");
  document.body.appendChild(div1);
  document.body.appendChild(div2);
  let width1 = div1.getBoundingClientRect().width;
  let width2 = div2.getBoundingClientRect().width;
  let diff = width2-width1;
  let passed = Math.abs(diff) > 0.01;
  return {
    "System font detection": {
      description: "Web pages can detect the presence of a font installed on the user's system. The presence or absence of various fonts is commonly used to fingerprint users.",
      passed
    }
  }
};

const runTests = async () => {
  let resultsJSON = Object.assign({}, await testIp(), testFontFingerprinting());
  document.body.setAttribute("data-test-results", JSON.stringify(resultsJSON));
  await postData(resultsJSON, "supplementary");
};

runTests();
