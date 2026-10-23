import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val buildId: String = System.getenv("CC_BUILD") ?: "dev"
val keystorePath: String? = System.getenv("CC_KEYSTORE")

android {
    namespace = "io.github.pmderek.cardcomp"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.pmderek.cardcomp"
        minSdk = 33
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "BUILD_ID", "\"$buildId\"")
    }

    signingConfigs {
        create("release") {
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storePassword = System.getenv("CC_KEYSTORE_PASS") ?: ""
                keyAlias = System.getenv("CC_KEY_ALIAS") ?: "cardcomp"
                keyPassword = System.getenv("CC_KEY_PASS") ?: (System.getenv("CC_KEYSTORE_PASS") ?: "")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystorePath != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// No library dependencies on purpose: platform APIs only (WebView, WindowManager, MediaProjection, accessibility).
