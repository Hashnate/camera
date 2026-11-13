import dotenv from 'dotenv';
dotenv.config();

export const ENV = {
  PORT: parseInt(process.env.PORT || '5000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || 'worksight_default_secret_key_change_in_production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  
  // EZVIZ Open Platform
  EZVIZ_APP_KEY: process.env.EZVIZ_APP_KEY || '',
  EZVIZ_APP_SECRET: process.env.EZVIZ_APP_SECRET || '',
  EZVIZ_ACCESS_TOKEN: process.env.EZVIZ_ACCESS_TOKEN || '',
  EZVIZ_API_BASE_URL: process.env.EZVIZ_API_BASE_URL || 'https://open.ezvizlife.com',
  EZVIZ_DEVICE_SERIAL: process.env.EZVIZ_DEVICE_SERIAL || '',
  
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
};

