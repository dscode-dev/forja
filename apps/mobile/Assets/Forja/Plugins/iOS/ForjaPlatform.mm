#import <AuthenticationServices/AuthenticationServices.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#include <stdlib.h>
#include <string.h>
extern "C" UIViewController *UnityGetGLViewController(void);

static NSString *service(void) { return [[[NSBundle mainBundle] bundleIdentifier] stringByAppendingString:@".session.v1"]; }
static NSMutableDictionary *query(void) {
    return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService:service(), (__bridge id)kSecAttrAccount:@"refresh",
        (__bridge id)kSecAttrSynchronizable:@NO} mutableCopy];
}
extern "C" int ForjaCredentialDelete(void) {
    OSStatus s=SecItemDelete((__bridge CFDictionaryRef)query());
    return s==errSecItemNotFound ? 0 : (int)s;
}
extern "C" int ForjaCredentialWrite(const char *value) {
    if (!value || strlen(value)!=43) return -1;
    NSData *data=[NSData dataWithBytes:value length:strlen(value)];
    NSDictionary *attributes=@{(__bridge id)kSecValueData:data,
        (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly};
    OSStatus s=SecItemUpdate((__bridge CFDictionaryRef)query(),(__bridge CFDictionaryRef)attributes);
    if(s==errSecItemNotFound) {
        NSMutableDictionary *q=query(); [q addEntriesFromDictionary:attributes];
        s=SecItemAdd((__bridge CFDictionaryRef)q,NULL);
    }
    return (int)s;
}
extern "C" char *ForjaCredentialRead(int *status) {
    NSMutableDictionary *q=query(); q[(__bridge id)kSecReturnData]=@YES;
    q[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitOne;
    CFTypeRef output=NULL; OSStatus s=SecItemCopyMatching((__bridge CFDictionaryRef)q,&output);
    *status=s==errSecItemNotFound?0:(int)s;
    if(s!=errSecSuccess) return NULL;
    NSData *data=CFBridgingRelease(output);
    if(data.length!=43) { *status=-1; return NULL; }
    char *copy=(char*)calloc(data.length+1,1); memcpy(copy,data.bytes,data.length); return copy;
}
extern "C" void ForjaFree(char *value) { if(value) { size_t length=strlen(value); volatile unsigned char *bytes=(volatile unsigned char*)value; while(length>0) bytes[--length]=0; free(value); } }

@interface ForjaBrowser : NSObject<ASWebAuthenticationPresentationContextProviding>
@property(nonatomic,strong) ASWebAuthenticationSession *session;
@property(nonatomic,strong) NSString *result;
@property(nonatomic,assign) int status;
@end
@implementation ForjaBrowser
- (ASPresentationAnchor)presentationAnchorForWebAuthenticationSession:(ASWebAuthenticationSession *)session {
    return UnityGetGLViewController().view.window;
}
@end
static ForjaBrowser *browser;
extern "C" void ForjaAuthCancel(void) {
    ForjaBrowser *old=browser; browser=nil; [old.session cancel]; old.result=nil; old.session=nil;
}
extern "C" int ForjaAuthStart(const char *address,const char *scheme) {
    if(![NSThread isMainThread]) return -1;
    ForjaAuthCancel(); NSURL *url=[NSURL URLWithString:[NSString stringWithUTF8String:address]];
    if(![url.scheme isEqualToString:@"https"] || !UnityGetGLViewController().view.window) return -1;
    ForjaBrowser *flow=[ForjaBrowser new]; browser=flow;
    __weak ForjaBrowser *weakFlow=flow;
    flow.session=[[ASWebAuthenticationSession alloc] initWithURL:url callbackURLScheme:[NSString stringWithUTF8String:scheme] completionHandler:^(NSURL *callback,NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            ForjaBrowser *current=weakFlow; if(!current || browser!=current) return;
            current.result=error?nil:callback.absoluteString; current.status=error?-1:1;
        });
    }];
    flow.session.presentationContextProvider=flow; flow.session.prefersEphemeralWebBrowserSession=YES;
    if(![flow.session start]) { ForjaAuthCancel(); return -1; } return 0;
}
extern "C" char *ForjaAuthPoll(int *status) {
    *status=browser?browser.status:-1;
    if(*status==1 && UIApplication.sharedApplication.applicationState!=UIApplicationStateActive) { *status=0; return NULL; }
    if(*status!=1) return NULL;
    char *result=strdup(browser.result.UTF8String); browser.result=nil; return result;
}
static UIView *cover;
static BOOL contentHidden = YES;
static void coverPrivacy(void) {
    UIView *view=UnityGetGLViewController().view;
    if(!view) return;
    if(!cover) { cover=[[UIView alloc] initWithFrame:view.bounds]; cover.backgroundColor=[UIColor colorWithRed:0.07 green:0.10 blue:0.16 alpha:1]; cover.autoresizingMask=UIViewAutoresizingFlexibleWidth|UIViewAutoresizingFlexibleHeight; }
    cover.frame=view.bounds; [view addSubview:cover];
}
static void updatePrivacy(void) {
    if(contentHidden || UIScreen.mainScreen.isCaptured || UIApplication.sharedApplication.applicationState!=UIApplicationStateActive) coverPrivacy();
    else [cover removeFromSuperview];
}
extern "C" void ForjaPrivacy(int hidden) {
    contentHidden = hidden != 0;
    updatePrivacy();
}
__attribute__((constructor)) static void installPrivacy(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationWillResignActiveNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n){ contentHidden=YES; updatePrivacy(); }];
        [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidBecomeActiveNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n){ updatePrivacy(); }];
        [NSNotificationCenter.defaultCenter addObserverForName:UIScreenCapturedDidChangeNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n){ updatePrivacy(); }];
    });
}
