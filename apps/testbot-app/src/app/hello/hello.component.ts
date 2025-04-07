import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-hello',
  imports: [CommonModule],
  templateUrl: './hello.component.html',
  styleUrl: './hello.component.scss',
})
export class HelloComponent {
  testData = environment.testValue;
  env = environment.environmentName;
}
