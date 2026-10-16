plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
android {
    namespace = "org.bungee.app"
    compileSdk = 36
    defaultConfig { applicationId = "org.bungee.app"; minSdk = 31; targetSdk = 36; versionCode = 8; versionName = "0.1.0-alpha.8"; ndk { abiFilters += setOf("arm64-v8a", "x86_64") } }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    val ownerKeystore = providers.environmentVariable("BUNGEE_OWNER_KEYSTORE").orNull
    signingConfigs {
        if (ownerKeystore != null) create("owner") {
            storeFile = file(ownerKeystore)
            storePassword = providers.environmentVariable("BUNGEE_OWNER_STORE_PASSWORD").orNull ?: error("Owner keystore password is required")
            keyAlias = providers.environmentVariable("BUNGEE_OWNER_KEY_ALIAS").orNull ?: "bungee"
            keyPassword = providers.environmentVariable("BUNGEE_OWNER_KEY_PASSWORD").orNull ?: storePassword
        }
    }
    buildTypes { release {
        isMinifyEnabled = true
        proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        if (ownerKeystore != null) signingConfig = signingConfigs.getByName("owner")
    } }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}
dependencies {
    implementation(files("libs/bungee-transport.aar"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    implementation(platform("androidx.compose:compose-bom:2025.05.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.fragment:fragment-ktx:1.8.6")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.wireguard.android:tunnel:1.0.20260102")
    implementation("com.google.code.findbugs:jsr305:3.0.2")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
