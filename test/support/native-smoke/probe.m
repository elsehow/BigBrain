// Disposable-profile boundary probe. Never probes a real profile or remote host.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <Network/Network.h>

@interface Probe : NSObject <WKNavigationDelegate>
@property(strong) WKWebView *web;
@property(strong) NSWindow *window;
@end
@implementation Probe
- (void)webView:(WKWebView *)web didFinishNavigation:(WKNavigation *)navigation {
    NSString *port = NSProcessInfo.processInfo.environment[@"DENIED_PORT"];
    NSString *js = [NSString stringWithFormat:@"Promise.all([fetch('/allowed').then(r=>r.text()), fetch('http://127.0.0.1:%@/forbidden', {mode:'no-cors'}).then(()=> 'ESCAPED',()=> 'BLOCKED')]).then(x=>JSON.stringify(x))", port];
    js = [@"return " stringByAppendingString:js];
    [web callAsyncJavaScript:js arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
        printf("WEBKIT %s error=%s\n", [[value description] UTF8String], [[error description] UTF8String]);
        fflush(stdout);
        [NSApp terminate:nil];
    }];
}
@end
int main(void) {
    @autoreleasepool {
        NSDictionary *env = NSProcessInfo.processInfo.environment;
        printf("FOUNDATION_HOME %s\n", NSHomeDirectory().UTF8String);
        NSError *error = nil;
        NSString *forbidden = [env[@"PROBE_ROOT"] stringByAppendingPathComponent:@"forbidden/canary"];
        NSString *read = [NSString stringWithContentsOfFile:forbidden encoding:NSUTF8StringEncoding error:&error];
        printf("FILE_READ %s\n", read ? "ESCAPED" : "BLOCKED");
        BOOL wrote = [@"changed" writeToFile:forbidden atomically:NO encoding:NSUTF8StringEncoding error:&error];
        printf("FILE_WRITE %s\n", wrote ? "ESCAPED" : "BLOCKED");
        NSString *safe = [env[@"HOME"] stringByAppendingPathComponent:@"allowed-canary"];
        BOOL safeWrite = [@"safe" writeToFile:safe atomically:YES encoding:NSUTF8StringEncoding error:&error];
        printf("FILE_ALLOWED_WRITE %s %s\n", safeWrite ? "ALLOWED" : "FAILED", safeWrite ? "" : error.description.UTF8String);
        printf("FOUNDATION_TMP %s\n", NSTemporaryDirectory().UTF8String);
        fflush(stdout);
        [NSApplication sharedApplication];
        Probe *probe = [Probe new];
        WKWebViewConfiguration *config = [WKWebViewConfiguration new];
        config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        if (env[@"PROXY_PORT"]) {
            nw_endpoint_t endpoint = nw_endpoint_create_host("127.0.0.1", [env[@"PROXY_PORT"] UTF8String]);
            nw_proxy_config_t proxy = nw_proxy_config_create_http_connect(endpoint, NULL);
            nw_proxy_config_set_failover_allowed(proxy, false);
            [config.websiteDataStore setValue:@[proxy] forKey:@"proxyConfigurations"];
        }
        probe.web = [[WKWebView alloc] initWithFrame:NSMakeRect(0,0,500,300) configuration:config];
        probe.web.navigationDelegate = probe;
        probe.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,500,300) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        probe.window.contentView = probe.web;
        [probe.window orderFront:nil];
        NSString *url = [NSString stringWithFormat:@"http://127.0.0.1:%@/",env[@"ALLOWED_PORT"]];
        void (^load)(void) = ^{ [probe.web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:url]]]; };
        if (env[@"CONTENT_BLOCK"]) {
            NSArray *rules = @[
                @{@"trigger": @{@"url-filter": @".*"}, @"action": @{@"type": @"block"}},
                @{@"trigger": @{@"url-filter": [NSString stringWithFormat:@"^http://127[.]0[.]0[.]1:%@/", env[@"ALLOWED_PORT"]]}, @"action": @{@"type": @"ignore-previous-rules"}}
            ];
            NSString *json = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:rules options:0 error:nil] encoding:NSUTF8StringEncoding];
            NSURL *storeURL = [NSURL fileURLWithPath:[env[@"HOME"] stringByAppendingPathComponent:@"rules"]];
            [[WKContentRuleListStore storeWithURL:storeURL] compileContentRuleListForIdentifier:@"boundary" encodedContentRuleList:json completionHandler:^(WKContentRuleList *list, NSError *err) {
                if (!list) { NSLog(@"rule compile failed %@",err); [NSApp terminate:nil]; return; }
                [config.userContentController addContentRuleList:list];
                load();
            }];
        } else load();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20*NSEC_PER_SEC), dispatch_get_main_queue(), ^{ puts("TIMEOUT"); fflush(stdout); [NSApp terminate:nil]; });
        [NSApp run];
    }
    return 0;
}
