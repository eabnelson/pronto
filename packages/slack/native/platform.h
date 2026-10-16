#include <stdlib.h>
int slack_keychain(int interactive, unsigned char **result, int *length);
int slack_cookie(const char *file, unsigned char **result, int *length);
int slack_power_start(void);
int slack_power_wake_count(void);
