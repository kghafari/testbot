import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { HelloComponent } from "./hello/hello.component";

@Component({
  imports: [ RouterModule, HelloComponent],
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  title = 'testbot-app';
}
