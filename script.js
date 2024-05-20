<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gaming Editor Portfolio</title>
    <!-- Tailwind CSS CDN -->
    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.16/dist/tailwind.min.css" rel="stylesheet">
    <!-- Custom CSS -->
    <style>
        /* Add any custom CSS styles here */
    </style>
</head>

<body class="bg-gray-100">
    <!-- Navbar -->
    <nav class="bg-gray-800 text-white p-4">
        <div class="container mx-auto flex justify-between items-center">
            <a href="#" class="text-lg font-bold">Gaming Editor Portfolio</a>
            <div class="flex space-x-4">
                <a href="#home" class="hover:text-gray-300">Home</a>
                <a href="#projects" class="hover:text-gray-300">Projects</a>
                <a href="#about" class="hover:text-gray-300">About</a>
                <a href="#contact" class="hover:text-gray-300">Contact</a>
            </div>
        </div>
    </nav>

    <!-- Hero Section -->
    <header id="home" class="bg-gray-900 text-white py-20">
        <div class="container mx-auto text-center">
            <h1 class="text-4xl font-bold mb-4">Welcome to My Gaming Editor Portfolio</h1>
            <p class="text-lg">I specialize in Java game development. Check out my work below!</p>
        </div>
    </header>

    <!-- Projects Section -->
    <section id="projects" class="py-16">
        <div class="container mx-auto">
            <h2 class="text-2xl font-bold mb-8 text-center">Projects</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                <!-- Project Cards -->
                <div class="bg-white rounded-lg shadow-md overflow-hidden">
                    <img src="project1.jpg" alt="Project 1" class="w-full h-48 object-cover">
                    <div class="p-4">
                        <h3 class="font-semibold text-lg mb-2">Project 1</h3>
                        <p class="text-gray-600">Description of Project 1</p>
                    </div>
                </div>
                <!-- Add more project cards as needed -->
            </div>
        </div>
    </section>

    <!-- About Section -->
    <section id="about" class="py-16 bg-gray-200">
        <div class="container mx-auto">
            <h2 class="text-2xl font-bold mb-8 text-center">About Me</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div>
                    <h3 class="font-semibold text-lg mb-2">Who Am I?</h3>
                    <p class="text-gray-600">Brief introduction about yourself and your expertise in gaming editing and Java development.</p>
                </div>
                <div>
                    <h3 class="font-semibold text-lg mb-2">Skills</h3>
                    <ul class="list-disc text-gray-600">
                        <li>Java Programming</li>
                        <li>Game Development</li>
                        <li>Gaming Editing</li>
                        <!-- Add more skills -->
                    </ul>
                </div>
            </div>
        </div>
    </section>

    <!-- Contact Section -->
    <section id="contact" class="py-16">
        <div class="container mx-auto">
            <h2 class="text-2xl font-bold mb-8 text-center">Contact Me</h2>
            <form id="contact-form" class="max-w-lg mx-auto">
                <div class="mb-4">
                    <label for="name" class="block text-gray-700">Name</label>
                    <input type="text" id="name" name="name" class="w-full px-4 py-2 rounded-lg border border-gray-300 focus:outline-none focus:border-gray-500" placeholder="Your Name" required>
                </div>
                <div class="mb-4">
                    <label for="email" class="block text-gray-700">Email Address</label>
                    <input type="email" id="email" name="email" class="w-full px-4 py-2 rounded-lg border border-gray-300 focus:outline-none focus:border-gray-500" placeholder="Your Email" required>
                </div>
                <div class="mb-4">
                    <label for="message" class="block text-gray-700">Message</label>
                    <textarea id="message" name="message" rows="4" class="w-full px-4 py-2 rounded-lg border border-gray-300 focus:outline-none focus:border-gray-500" placeholder="Your Message" required></textarea>
                </div>
                <div class="text-center">
                    <button type="submit"
