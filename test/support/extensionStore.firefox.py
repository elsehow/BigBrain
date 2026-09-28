"""Real Firefox extension smoke test against extensionStoreHarness.ts.

Requires selenium (verified with 4.49.0) and geckodriver. Set EXTENSION_TEST_BASE.
Optional FIREFOX_BINARY, EXTENSION_XPI, EXTENSION_OLD_FIREFOX, EXTENSION_SCREENSHOTS.
Uses only a new WebDriver profile and the disposable loopback vault.
"""
import base64
import json
import os
from pathlib import Path
import time
import urllib.request
import uuid

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

BASE = os.environ["EXTENSION_TEST_BASE"]
assert BASE.startswith("http://127.0.0.1:"), "Use the disposable intake harness"
XPI = Path(os.environ.get("EXTENSION_XPI", "site/dist/plugins/send_to_bigbrain-0.9.5-unsigned.xpi")).resolve(strict=True)
ADDON_ID = "extension@bigbrain.cool"
RUN = uuid.uuid4().hex[:10]


def fixture(path):
    with urllib.request.urlopen(BASE + "/fixture/" + path, timeout=10) as response:
        return json.load(response)


options = Options()
options.add_argument("-headless")
options.binary_location = os.environ.get("FIREFOX_BINARY", "/Applications/Firefox.app/Contents/MacOS/firefox")
driver = webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))
wait = WebDriverWait(driver, 20)


def install(path):
    # Selenium's install_addon uploads base64; geckodriver then deletes that
    # temporary XPI. Firefox 140/141's parent still has cached files, but its
    # content process cannot open the deleted archive (FILE_ACCESS_DENIED).
    # Keep the real XPI available for the entire temporary-addon session.
    driver.execute("INSTALL_ADDON", {"path": str(Path(path).resolve(strict=True)), "temporary": True})
    driver.set_context("chrome")
    info = driver.execute_script("""
        const extension = WebExtensionPolicy.getByID(arguments[0]).extension;
        const uri = extension.rootURI.QueryInterface(Ci.nsIJARURI);
        return {url: extension.rootURI.spec, exists: uri.JARFile.QueryInterface(Ci.nsIFileURL).file.exists(),
                options: 'moz-extension://' + WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname + '/options.html'};
    """, ADDON_ID)
    assert info["exists"], f"Temporary XPI disappeared: {info['url']}"
    driver.set_context("content")
    driver.switch_to.window(driver.window_handles[-1])
    return info["options"]


def pair(options_url):
    driver.set_context("content")
    driver.get(options_url)
    wait.until(lambda _: driver.find_element(By.ID, "state").text == "NOT CONNECTED")
    endpoint = driver.find_element(By.ID, "endpoint")
    endpoint.clear()
    endpoint.send_keys(BASE)
    driver.find_element(By.ID, "code").send_keys(fixture("pair")["code"])
    driver.find_element(By.ID, "connect").click()

    def connected(_):
        driver.set_context("chrome")
        # Firefox versions differ in whether the explicit origin request
        # prompts for already declared localhost access. Accept only a
        # visible permission prompt in this isolated profile.
        driver.execute_script("""
            for (const button of document.querySelectorAll('.popup-notification-primary-button')) {
                if (button.getBoundingClientRect().width) button.click();
            }
        """)
        driver.set_context("content")
        return driver.find_element(By.ID, "state").text == "CONNECTED"
    try:
        wait.until(connected)
    except Exception:
        print("PAIRING FAILURE:", driver.find_element(By.TAG_NAME, "body").text, flush=True)
        driver.set_context("chrome")
        print("PERMISSION PANEL:", driver.execute_script("return document.getElementById('notification-popup').textContent"), flush=True)
        raise


def popup_script(script):
    # Firefox's popup is an out-of-process XUL browser, not a WebDriver
    # iframe or top-level tab. Use its existing Marionette actor to inspect
    # the real popup document; no test script enters the shipped extension.
    return driver.execute_async_script("""
        const [script, done] = arguments;
        const popup = document.querySelector('browser.webextension-popup-browser');
        popup.browsingContext.currentWindowGlobal.getActor('MarionetteCommands')
            .executeScript(script, [], {}).then(done, error => done({error: String(error)}));
    """, script)


def open_capture(url):
    driver.set_context("content")
    driver.get(url)
    driver.set_context("chrome")
    driver.execute_script("CustomizableUI.addWidgetToArea('extension_bigbrain_cool-browser-action', CustomizableUI.AREA_NAVBAR)")
    driver.find_element(By.CSS_SELECTOR, "#extension_bigbrain_cool-browser-action .webextension-browser-action").click()
    wait.until(lambda _: driver.find_elements(By.CSS_SELECTOR, "browser.webextension-popup-browser"))


def wait_status(expected):
    wait.until(lambda _: popup_script("return document.getElementById('status')?.textContent") == expected)


try:
    driver.set_window_size(1280, 800)
    driver.get(BASE + "/article")  # retain an ordinary tab across an addon upgrade
    old = os.environ.get("EXTENSION_OLD_FIREFOX")
    if old:
        old_options = install(old)
        driver.switch_to.new_window("tab")
        driver.get(old_options)
        driver.execute_async_script("""
            browser.storage.local.set({endpoint:'https://bigbrain.cool',token:'synthetic-retired-token',account:'alex@example.test'}).then(arguments[0]);
        """)
    options_url = install(XPI)
    driver.get(options_url)
    wait.until(lambda _: driver.find_element(By.ID, "state").text == "NOT CONNECTED")
    stored = driver.execute_async_script("browser.storage.local.get(['endpoint','token','account']).then(arguments[0])")
    assert not stored, "Fresh/upgrade pairing must not retain hosted credentials"
    pair(options_url)

    before = len(fixture("evidence"))
    article = BASE + "/article?run=" + RUN
    open_capture(article)
    wait_status("IN THE VAULT")
    wait.until(lambda _: len(fixture("evidence")) == before + 1)
    assert fixture("evidence")[-1]["title"] == "A small guide to urban gardens"

    screenshots = os.environ.get("EXTENSION_SCREENSHOTS")
    if screenshots:
        time.sleep(1)  # let the cube finish its visual settle, after success
        png = driver.execute_async_script("""
            const done=arguments[0], b=document.querySelector('browser.webextension-popup-browser');
            const rect=b.getBoundingClientRect();
            b.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0,0,rect.width,rect.height),2,'white').then(bitmap=>{
                const canvas=document.createElementNS('http://www.w3.org/1999/xhtml','canvas');
                canvas.width=bitmap.width;canvas.height=bitmap.height;
                canvas.getContext('2d').drawImage(bitmap,0,0);done(canvas.toDataURL());
            });
        """)
        dest = Path(screenshots)
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "firefox-popup.png").write_bytes(base64.b64decode(png.split(",", 1)[1]))

    note = "Firefox verification note " + RUN
    popup_script("const note=document.getElementById('note');note.value=" + json.dumps(note) + ";note.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;")
    wait.until(lambda _: any(source["body"] == note for source in fixture("evidence")))
    wait.until(lambda _: not driver.find_elements(By.CSS_SELECTOR, "browser.webextension-popup-browser"))

    # Reopen without navigation: reuse the existing capture, don't enqueue
    # another page. Then revoke and navigate to ensure a fresh request fails.
    driver.find_element(By.CSS_SELECTOR, "#extension_bigbrain_cool-browser-action .webextension-browser-action").click()
    wait_status("IN THE VAULT")
    assert len(fixture("evidence")) == before + 2
    popup_script("window.close();")
    wait.until(lambda _: not driver.find_elements(By.CSS_SELECTOR, "browser.webextension-popup-browser"))
    fixture("revoke")
    open_capture(article + "&revoked=1")
    wait_status("SEND FAILED")
    assert len(fixture("evidence")) == before + 2
    popup_script("window.close();")
    driver.set_context("content")
    driver.get(options_url)
    driver.find_element(By.ID, "disconnect").click()
    pair(options_url)
    open_capture(article + "&reconnected=1")
    wait_status("IN THE VAULT")
    wait.until(lambda _: len(fixture("evidence")) == before + 3)
    print(json.dumps({"firefox": driver.capabilities["browserVersion"], "upgrade": bool(old),
                      "passed": ["pairing", "capture", "note", "reopen", "revocation", "reconnect"]}), flush=True)
finally:
    driver.quit()
