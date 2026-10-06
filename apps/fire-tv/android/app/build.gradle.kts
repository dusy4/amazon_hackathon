plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.semanticplayback.firetv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.semanticplayback.firetv"
        minSdk = 25 // Fire OS 6+ (Fire TV Stick 4K and newer)
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        // Emulator → host machine. Override at launch: adb shell am start ... --es server http://<lan-ip>:8787
        buildConfigField("String", "DEFAULT_SERVER", "\"http://10.0.2.2:8787\"")
    }
    buildFeatures { buildConfig = true }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    val media3 = "1.3.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("androidx.media3:media3-session:$media3")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
