import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { environment } from './environments/environment';

console.log('environment', environment.environmentName);
console.log('testValue', environment.testValue);
bootstrapApplication(AppComponent, appConfig).catch((err) =>
  console.error(err)
);
