package com.llmwiki.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.core.os.LocaleListCompat
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.appPreferencesDataStore by preferencesDataStore(name = "app-preferences")

enum class ThemeMode {
    SYSTEM,
    LIGHT,
    DARK,
}

enum class AppLanguage(val tag: String?) {
    SYSTEM(null),
    ZH_TW("zh-TW"),
    EN("en");

    fun toLocaleList(): LocaleListCompat =
        tag?.let(LocaleListCompat::forLanguageTags) ?: LocaleListCompat.getEmptyLocaleList()
}

class AppPreferencesRepository(context: Context) {

    private val appContext = context.applicationContext
    private val dataStore = appContext.appPreferencesDataStore

    val themeMode: Flow<ThemeMode> = dataStore.data
        .map { preferences ->
            preferences[THEME_MODE_KEY]
                ?.let(::themeModeFromValue)
                ?: ThemeMode.SYSTEM
        }
        .distinctUntilChanged()

    val language: Flow<AppLanguage> = dataStore.data
        .map { preferences ->
            preferences[LANGUAGE_KEY]
                ?.let(::languageFromValue)
                ?: AppLanguage.SYSTEM
        }
        .distinctUntilChanged()

    suspend fun setThemeMode(value: ThemeMode) {
        dataStore.edit { preferences ->
            preferences[THEME_MODE_KEY] = value.name
        }
    }

    suspend fun setLanguage(value: AppLanguage) {
        dataStore.edit { preferences ->
            preferences[LANGUAGE_KEY] = value.name
        }
    }

    suspend fun getLanguage(): AppLanguage = language.first()

    private fun themeModeFromValue(value: String): ThemeMode =
        runCatching { ThemeMode.valueOf(value) }.getOrDefault(ThemeMode.SYSTEM)

    private fun languageFromValue(value: String): AppLanguage =
        runCatching { AppLanguage.valueOf(value) }.getOrDefault(AppLanguage.SYSTEM)

    private companion object {
        val THEME_MODE_KEY = stringPreferencesKey("theme_mode")
        val LANGUAGE_KEY = stringPreferencesKey("language")
    }
}
