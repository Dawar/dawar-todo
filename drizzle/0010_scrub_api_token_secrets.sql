UPDATE `todo_api_tokens` SET `encrypted_token` = NULL WHERE `encrypted_token` IS NOT NULL;
