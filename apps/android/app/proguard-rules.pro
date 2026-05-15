# Supabase / Ktor
-keep class io.github.jan.supabase.** { *; }
-keep class io.ktor.** { *; }

# Google APIs
-keep class com.google.api.** { *; }
-keep class com.google.apis.** { *; }

# Apache HttpClient classes not available on Android (referenced by Google Drive SDK)
-dontwarn javax.naming.**
-dontwarn org.ietf.jgss.**
-dontwarn org.apache.http.conn.ssl.**
-dontwarn org.apache.http.impl.auth.**

# Ktor IntelliJ debug detector references JVM management APIs not on Android
-dontwarn java.lang.management.ManagementFactory
-dontwarn java.lang.management.RuntimeMXBean

# Kotlinx Serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class **$$serializer { *; }
