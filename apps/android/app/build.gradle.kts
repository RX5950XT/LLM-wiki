import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

fun loadPropertiesFile(path: String): Properties = Properties().apply {
    val file = rootProject.file(path)
    if (file.exists()) {
        file.inputStream().use(::load)
    }
}

val localProperties = Properties().apply {
    putAll(loadPropertiesFile("../../.env.local"))
    putAll(loadPropertiesFile("../../apps/web/.env.local"))
    putAll(loadPropertiesFile("local.properties"))
}

fun configValue(vararg keys: String): String = keys
    .firstNotNullOfOrNull { key ->
        (localProperties[key] as? String)?.takeIf { it.isNotBlank() }
            ?: System.getenv(key)?.takeIf { it.isNotBlank() }
    }
    ?: ""

fun requiredConfigValue(name: String, vararg keys: String): String = configValue(*keys).ifBlank {
    throw GradleException(
        "Missing Android config $name. Add ${keys.joinToString(" or ")} to apps/android/local.properties, repo .env.local, or environment variables."
    )
}

fun buildConfigString(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

android {
    namespace = "com.llmwiki"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.llmwiki"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Supabase config injected at build time
        buildConfigField(
            "String",
            "SUPABASE_URL",
            buildConfigString(requiredConfigValue("SUPABASE_URL", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")),
        )
        buildConfigField(
            "String",
            "SUPABASE_ANON_KEY",
            buildConfigString(requiredConfigValue("SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY")),
        )
        buildConfigField(
            "String",
            "GOOGLE_CLIENT_ID",
            buildConfigString(requiredConfigValue("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID")),
        )
        buildConfigField(
            "String",
            "WEB_API_BASE_URL",
            buildConfigString(requiredConfigValue("WEB_API_BASE_URL", "WEB_API_BASE_URL", "NEXT_PUBLIC_SITE_URL")),
        )
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/INDEX.LIST",
                "META-INF/DEPENDENCIES",
                "META-INF/*.kotlin_module",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)

    // Compose BOM
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.material3)
    debugImplementation(libs.androidx.ui.tooling)

    // Supabase
    implementation(platform(libs.supabase.bom))
    implementation(libs.supabase.postgrest)
    implementation(libs.supabase.auth)
    implementation(libs.supabase.realtime)
    implementation(libs.supabase.compose.auth)

    // Ktor
    implementation(libs.ktor.client.android)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.serialization.kotlinx.json)

    // Room
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    // WorkManager
    implementation(libs.androidx.work.runtime.ktx)

    // Google Sign-In
    implementation(libs.play.services.auth)

    // DataStore
    implementation(libs.androidx.datastore.preferences)

    // Kotlinx Serialization
    implementation(libs.kotlinx.serialization.json)

    // Google Drive API
    implementation(libs.google.api.client.android)
    implementation(libs.google.api.services.drive)

    // Markwon (markdown rendering in Compose via AndroidView)
    implementation(libs.markwon.core)
    implementation(libs.markwon.strikethrough)
    implementation(libs.markwon.tables)
}
