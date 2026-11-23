plugins { id("com.android.application") }

// Підпис релізу: файл ключа й паролі передаються через змінні середовища (GitHub Secrets)
val ksFile = System.getenv("INFOKLAS_KEYSTORE")
android {
    namespace = "ua.school.infoklas.teacher"
    compileSdk = 35
    defaultConfig {
        applicationId = "ua.school.infoklas.teacher"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("INFOKLAS_VERSION_CODE") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("INFOKLAS_VERSION_CODE") ?: "0")
    }
    signingConfigs {
        if (ksFile != null) create("release") {
            storeFile = file(ksFile)
            storePassword = System.getenv("INFOKLAS_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("INFOKLAS_KEY_ALIAS") ?: "infoklas"
            keyPassword = System.getenv("INFOKLAS_KEY_PASSWORD") ?: System.getenv("INFOKLAS_KEYSTORE_PASSWORD")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (ksFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
