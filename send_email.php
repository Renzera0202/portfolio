<?php
if ($_SERVER["REQUEST_METHOD"] == "POST") {
    $name = $_POST['name'];
    $email = $_POST['email'];
    $message = $_POST['message'];

    // Email recipient
    $to = "robertcorpuz0101@gmail.com";
    // Email subject
    $subject = "Message from Portfolio Website";

    // Email content
    $email_content = "Name: $name\n";
    $email_content .= "Email: $email\n\n";
    $email_content .= "Message:\n$message";

    // Email headers
    $headers = "From: $name <$email>";

    // Send email
    if (mail($to, $subject, $email_content, $headers)) {
        echo json_encode(array('success' => true, 'message' => 'Your message has been sent successfully!'));
    } else {
        echo json_encode(array('success' => false, 'message' => 'Oops! Something went wrong, please try again later.'));
    }
} else {
    echo json_encode(array('success' => false, 'message' => 'Invalid request.'));
}
?>
