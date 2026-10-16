#include "platform.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <IOKit/IOMessage.h>
#include <IOKit/pwr_mgt/IOPMLib.h>
#include <sqlite3.h>
#include <pthread.h>
#include <stdatomic.h>
#include <string.h>
#include <time.h>

int slack_keychain(int interactive, unsigned char **result, int *length) {
    const char *accounts[] = {"Slack Key", "Slack", "Slack App Store Key"};
    for (int i = 0; i < 3; i++) {
        CFStringRef account = CFStringCreateWithCString(NULL, accounts[i], kCFStringEncodingUTF8);
        const void *keys[] = {kSecClass, kSecAttrService, kSecAttrAccount, kSecReturnData, kSecMatchLimit, kSecUseAuthenticationUI};
        const void *values[] = {kSecClassGenericPassword, CFSTR("Slack Safe Storage"), account, kCFBooleanTrue, kSecMatchLimitOne, interactive ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail};
        CFDictionaryRef query = CFDictionaryCreate(NULL, keys, values, 6, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        CFTypeRef value = NULL;
        OSStatus status = SecItemCopyMatching(query, &value);
        CFRelease(query); CFRelease(account);
        if (status == errSecSuccess && value && CFGetTypeID(value) == CFDataGetTypeID()) {
            CFIndex size = CFDataGetLength(value);
            if (size <= 0 || size > 4096) { CFRelease(value); return 1; }
            *result = malloc(size); if (!*result) { CFRelease(value); return 1; }
            memcpy(*result, CFDataGetBytePtr(value), size); *length = (int)size; CFRelease(value); return 0;
        }
        if (value) CFRelease(value);
        if (status == errSecInteractionNotAllowed || status == errSecUserCanceled || status == errSecAuthFailed) return 2;
    }
    return 1;
}
int slack_cookie(const char *file, unsigned char **result, int *length) {
    sqlite3 *db = NULL; sqlite3_stmt *query = NULL;
    if (sqlite3_open_v2(file, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK) { if (db) sqlite3_close(db); return 1; }
    sqlite3_busy_timeout(db, 1500);
    int status = sqlite3_prepare_v2(db, "SELECT encrypted_value FROM cookies WHERE host_key='.slack.com' AND name='d' LIMIT 1", -1, &query, NULL);
    if (status != SQLITE_OK || sqlite3_step(query) != SQLITE_ROW) { if (query) sqlite3_finalize(query); sqlite3_close(db); return 1; }
    int size = sqlite3_column_bytes(query, 0);
    if (size < 19 || size > 16384) { sqlite3_finalize(query); sqlite3_close(db); return 1; }
    *result = malloc(size); if (!*result) { sqlite3_finalize(query); sqlite3_close(db); return 1; }
    memcpy(*result, sqlite3_column_blob(query, 0), size); *length = size;
    sqlite3_finalize(query); sqlite3_close(db); return 0;
}
static io_connect_t root_port;
static atomic_int wakes;
static pthread_mutex_t power_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t power_condition = PTHREAD_COND_INITIALIZER;
static int power_registered;
static void power_callback(void *ref, io_service_t service, natural_t type, void *argument) {
    (void)ref; (void)service;
    if (type == kIOMessageCanSystemSleep || type == kIOMessageSystemWillSleep) IOAllowPowerChange(root_port, (long)argument);
    if (type == kIOMessageSystemHasPoweredOn) atomic_fetch_add(&wakes, 1);
}
static void *power_run(void *argument) {
    (void)argument; IONotificationPortRef port; io_object_t notifier;
    root_port = IORegisterForSystemPower(NULL, &port, power_callback, &notifier);
    pthread_mutex_lock(&power_mutex);
    power_registered = root_port ? 1 : -1;
    pthread_cond_signal(&power_condition);
    pthread_mutex_unlock(&power_mutex);
    if (!root_port) return NULL;
    CFRunLoopAddSource(CFRunLoopGetCurrent(), IONotificationPortGetRunLoopSource(port), kCFRunLoopCommonModes);
    CFRunLoopRun(); return NULL;
}
int slack_power_start(void) {
    pthread_t thread;
    if (pthread_create(&thread, NULL, power_run, NULL)) return 1;
    pthread_detach(thread);
    struct timespec deadline; clock_gettime(CLOCK_REALTIME, &deadline); deadline.tv_sec += 3;
    pthread_mutex_lock(&power_mutex);
    while (!power_registered) { if (pthread_cond_timedwait(&power_condition, &power_mutex, &deadline)) break; }
    int result = power_registered == 1 ? 0 : 1;
    pthread_mutex_unlock(&power_mutex); return result;
}
int slack_power_wake_count(void) { return atomic_load(&wakes); }
