package com.llmwiki.ui

import androidx.compose.runtime.Composable
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.llmwiki.ui.auth.AuthScreen
import com.llmwiki.ui.wiki.WikiScreen

@Composable
fun LlmWikiNavGraph() {
    val navController = rememberNavController()

    NavHost(navController = navController, startDestination = "auth") {
        composable("auth") {
            AuthScreen(
                onAuthenticated = { navController.navigate("wiki") {
                    popUpTo("auth") { inclusive = true }
                }}
            )
        }
        composable(
            route = "wiki?workspaceId={workspaceId}",
            arguments = listOf(navArgument("workspaceId") {
                type = NavType.StringType
                nullable = true
                defaultValue = null
            })
        ) { backStackEntry ->
            WikiScreen(
                workspaceId = backStackEntry.arguments?.getString("workspaceId"),
            )
        }
    }
}
